/**
 * Dependency-free live verification (PLAN.md §8).
 *
 * Spawns the real server over stdio, speaks NDJSON MCP, and runs hard
 * assertions per subcommand. Non-zero exit on any failed check.
 *
 *   npm run verify -- list-sources | search-checkout | search-dashboard
 *                 | get-app-spotify | get-flows-onboarding | offline-cache | all
 *
 * The server inherits this process's environment — point UIMCP_CACHE_DIR
 * at a warm cache if you don't want the one-time catalog sync to run.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Rpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: any;
  error?: { code: number; message: string };
}

interface Client {
  init(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ isError: boolean; payload: any; text: string }>;
  close(): void;
  stderr(): string;
}

function createClient(extraEnv: Record<string, string> = {}): Client {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'node_modules/tsx/dist/cli.mjs', 'src/index.ts'],
    { env: { ...process.env, ...extraEnv } },
  );
  let buffer = '';
  const pending = new Map<number, (m: Rpc) => void>();
  const stderrLines: string[] = [];
  let nextId = 0;

  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', (d: Buffer) => stderrLines.push(d.toString()));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) stderrLines.push(`[server exited ${code}]`);
  });

  function request(method: string, params: unknown, timeoutMs: number): Promise<Rpc> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method} response`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  return {
    async init() {
      await request(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0.0.0' } },
        30_000,
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000) {
      const msg = await request('tools/call', { name, arguments: args }, timeoutMs);
      if (msg.error) throw new Error(`RPC error from ${name}: ${msg.error.message}`);
      const content: Array<{ type: string; text?: string }> = Array.isArray(msg.result?.content) ? msg.result.content : [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      let payload: any = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { rawText: text };
      }
      return { isError: Boolean(msg.result?.isError), payload, text };
    },
    close() {
      child.kill();
    },
    stderr() {
      return stderrLines.join('');
    },
  };
}

function fileUrl(url: string): string {
  return url.startsWith('file://') ? url.slice('file://'.length) : url;
}

function check(failures: string[], ok: unknown, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

/** §8.1 — every source healthy. */
async function listSources(failures: string[]): Promise<void> {
  const c = createClient();
  try {
    await c.init();
    const r = await c.callTool('list_sources', {}, 60_000);
    check(failures, !r.isError, 'list_sources ok');
    const p = r.payload;
    const names = (p?.sources ?? []).map((s: any) => s.name).sort();
    check(failures, JSON.stringify(names) === JSON.stringify(['apple', 'refero', 'screensdesign']), `3 sources reported (got ${names.join(',')})`);
    for (const s of p?.sources ?? []) {
      check(failures, s.ok === true, `${s.name} ok:true${s.note ? ` (note: ${s.note})` : ''}`);
    }
  } finally {
    c.close();
  }
}

/** §8.2 — checkout search: ≥5 records, first 5 cached full-res images >10KB on disk. */
async function searchCheckout(failures: string[]): Promise<void> {
  const c = createClient();
  try {
    await c.init();
    const r = await c.callTool('search_screens', { query: 'checkout', limit: 10 });
    check(failures, !r.isError, 'search_screens(checkout) ok');
    const p = r.payload;
    const results: any[] = p?.results ?? [];
    check(failures, results.length >= 5, `≥5 records (got ${results.length})`);
    let cachedOk = 0;
    for (const rec of results.slice(0, 5)) {
      const url = rec?.cachedUrls?.[0];
      const file = url ? fileUrl(url) : undefined;
      const ok = Boolean(file && fs.existsSync(file) && fs.statSync(file).size > 10 * 1024);
      if (ok) cachedOk++;
      check(failures, ok, `record ${rec?.id ?? '?'} cached on disk >10KB (${file ?? 'no cachedUrls'})`);
    }
    check(failures, cachedOk === 5, `all 5 first records cached (${cachedOk}/5)`);
  } finally {
    c.close();
  }
}

/** §8.3 — dashboard search: ≥1 web record, ≥1 record with palette. */
async function searchDashboard(failures: string[]): Promise<void> {
  const c = createClient();
  try {
    await c.init();
    const r = await c.callTool('search_screens', { query: 'dashboard', limit: 10 });
    check(failures, !r.isError, 'search_screens(dashboard) ok');
    const results: any[] = r.payload?.results ?? [];
    const web = results.filter((x) => x?.platform === 'web');
    check(failures, web.length >= 1, `≥1 web record (got ${web.length})`);
    check(failures, results.some((x) => Array.isArray(x?.colors) && x.colors.length >= 1), '≥1 record has colors[]');
  } finally {
    c.close();
  }
}

/** §8.4 — Spotify: ordered screens ≥5, Apple store shots ≥1, 720p video. */
async function getAppSpotify(failures: string[]): Promise<void> {
  const c = createClient();
  try {
    await c.init();
    const r = await c.callTool('get_app', { name: 'Spotify' });
    check(failures, !r.isError, 'get_app(Spotify) ok');
    const p = r.payload;
    const screens: any[] = p?.screens ?? [];
    const ordered = screens.filter((s) => s?.source === 'screensdesign');
    check(failures, /spotify/i.test(p?.app?.name ?? ''), `app name is Spotify (got "${p?.app?.name}")`);
    check(failures, ordered.length >= 5, `ordered ScreensDesign screens ≥5 (got ${ordered.length})`);
    // Frames come back in session order — timestamps non-decreasing.
    let orderedByTime = true;
    for (let i = 1; i < ordered.length; i++) {
      const a = Date.parse(ordered[i - 1]?.capturedAt ?? '');
      const b = Date.parse(ordered[i]?.capturedAt ?? '');
      if (Number.isFinite(a) && Number.isFinite(b) && b < a) orderedByTime = false;
    }
    check(failures, orderedByTime, 'frames in session order (non-decreasing timestamps)');
    check(failures, (p?.storeScreenshotCount ?? 0) >= 1, `Apple store screenshots ≥1 (got ${p?.storeScreenshotCount})`);
    check(
      failures,
      /^https:\/\/vz-[^/]+\.b-cdn\.net\/.+\/play_720p\.mp4$/.test(p?.videoUrl ?? ''),
      `video is a vz-*.b-cdn.net play_720p.mp4 (got ${p?.videoUrl})`,
    );
  } finally {
    c.close();
  }
}

/** §8.5 — Refero onboarding flows: ≥1 flow, multi-step. */
async function getFlowsOnboarding(failures: string[]): Promise<void> {
  const c = createClient();
  try {
    await c.init();
    const r = await c.callTool('get_flows', { query: 'onboarding', limit: 6 });
    check(failures, !r.isError, 'get_flows(onboarding) ok');
    const flows: any[] = r.payload?.flows ?? [];
    const refero = flows.filter((f) => f?.source === 'refero');
    check(failures, refero.length >= 1, `≥1 Refero flow (got ${refero.length} of ${flows.length})`);
    check(failures, refero.every((f) => Array.isArray(f.steps) && f.steps.length > 1), 'every Refero flow has >1 step');
    const firstFlowCache = refero[0]?.cachedUrls?.[0] ? fileUrl(refero[0].cachedUrls[0]) : undefined;
    check(
      failures,
      Boolean(firstFlowCache && fs.existsSync(firstFlowCache) && fs.statSync(firstFlowCache).size > 0),
      'first flow has a cached first-step image on disk (file:// path is usable)',
    );
  } finally {
    c.close();
  }
}

/** §8.6 — warm get_app, then the same call with UIMCP_FAKE_OFFLINE=1: every cachedUrl readable. */
async function offlineCache(failures: string[]): Promise<void> {
  const warm = createClient();
  try {
    await warm.init();
    const r = await warm.callTool('get_app', { name: 'Spotify' });
    check(failures, !r.isError, 'warm get_app(Spotify) ok');
  } finally {
    warm.close();
  }

  const off = createClient({ UIMCP_FAKE_OFFLINE: '1' });
  try {
    await off.init();
    const r = await off.callTool('get_app', { name: 'Spotify' }, 60_000);
    check(failures, !r.isError, 'offline get_app(Spotify) ok');
    const screens: any[] = r.payload?.screens ?? [];
    const withCache = screens.filter((s) => Array.isArray(s?.cachedUrls) && s.cachedUrls.length > 0);
    check(failures, withCache.length >= 10, `≥10 screens with cachedUrls (got ${withCache.length})`);
    let readable = 0;
    for (const s of withCache) {
      const file = fileUrl(s.cachedUrls[0]);
      let ok = false;
      try {
        ok = fs.statSync(file).size > 0 && fs.readFileSync(file).length > 0;
      } catch {
        ok = false;
      }
      if (ok) readable++;
    }
    check(failures, readable === withCache.length, `all cachedUrls readable offline (${readable}/${withCache.length})`);
  } finally {
    off.close();
  }
}

const COMMANDS: Record<string, { description: string; run: (failures: string[]) => Promise<void> }> = {
  'list-sources': { description: '§8.1 all three sources healthy', run: listSources },
  'search-checkout': { description: '§8.2 checkout search + full-res cache on disk', run: searchCheckout },
  'search-dashboard': { description: '§8.3 dashboard search, web coverage + palette', run: searchDashboard },
  'get-app-spotify': { description: '§8.4 Spotify depth: screens, store shots, video', run: getAppSpotify },
  'get-flows-onboarding': { description: '§8.5 Refero onboarding flows', run: getFlowsOnboarding },
  'offline-cache': { description: '§8.6 warm cache survives fake-offline', run: offlineCache },
};

const ALL = ['list-sources', 'search-checkout', 'search-dashboard', 'get-app-spotify', 'get-flows-onboarding', 'offline-cache'];

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'all';
  if (command === 'help' || command === '--help') {
    console.log('usage: npm run verify -- <command>');
    console.log('  ' + ALL.join(' | '));
    console.log('  all');
    process.exit(0);
  }
  const keys = command === 'all' ? ALL : [command];
  const unknown = keys.filter((k) => !(k in COMMANDS));
  if (unknown.length) {
    console.error(`unknown command: ${unknown.join(', ')} (try: ${ALL.join(', ')}, all)`);
    process.exit(2);
  }
  let failed = false;
  for (const k of keys) {
    const { description, run } = COMMANDS[k]!;
    console.log(`\n=== ${k} — ${description} ===`);
    const failures: string[] = [];
    const t0 = Date.now();
    try {
      await run(failures);
    } catch (e) {
      console.log(`  FAIL  ${e instanceof Error ? e.message : String(e)}`);
      failures.push(e instanceof Error ? e.message : String(e));
    }
    console.log(`  ${failures.length === 0 ? 'PASS' : 'FAIL'}  ${k} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${failures.length ? `${failures.length} failed` : 'all checks passed'}`);
    if (failures.length) failed = true;
  }
  console.log(failed ? '\nVERIFY: FAILED' : '\nVERIFY: ALL GREEN');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('verify crashed:', e);
  process.exit(1);
});
