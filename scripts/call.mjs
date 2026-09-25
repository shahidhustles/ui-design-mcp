/**
 * Minimal stdio NDJSON client for the ui-design MCP server.
 *
 *   node scripts/call.mjs <tool> '<json-args>' [imageOutDir]
 *
 * Spawns the built server (dist/index.js) in this repo's cwd so the warm
 * data/ cache is used. Prints the text payload to stdout; if imageOutDir is
 * given, any inline image blocks are written to files there (path printed to
 * stderr as WROTE_IMAGE:<path>). Exit 0 on success, 2 on RPC error.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const tool = process.argv[2];
const args = JSON.parse(process.argv[3] || '{}');
const imgOutDir = process.argv[4];

if (!tool) {
  console.error('usage: node scripts/call.mjs <tool> <json-args> [imageOutDir]');
  process.exit(64);
}

const child = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', path.join(SERVER_DIR, 'dist', 'index.js')],
  { cwd: SERVER_DIR, env: { ...process.env, UIMCP_CACHE_DIR: path.join(SERVER_DIR, 'data') } },
);

let buffer = '';
const pending = new Map();
let nextId = 0;
let stderrBuf = '';

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) {
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      resolve(m);
    }
  }
});
child.stderr.on('data', (d) => (stderrBuf += d.toString()));

function request(method, params, timeoutMs) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout after ${timeoutMs}ms on ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'call-cli', version: '0.0.0' } }, 30_000);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const msg = await request('tools/call', { name: tool, arguments: args }, 180_000);
  if (msg.error) { console.error('RPC error from ' + tool + ': ' + msg.error.message); process.exit(2); }
  const content = Array.isArray(msg.result?.content) ? msg.result.content : [];
  const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const imgBlocks = content.filter((b) => b.type === 'image');
  if (imgOutDir && imgBlocks.length) {
    fs.mkdirSync(imgOutDir, { recursive: true });
    imgBlocks.forEach((b, i) => {
      const ext = (b.mimeType || '').includes('png') ? '.png' : '.jpg';
      const p = path.join(imgOutDir, `${tool}_${i}${ext}`);
      fs.writeFileSync(p, Buffer.from(b.data, 'base64'));
      console.error('WROTE_IMAGE:' + p);
    });
  }
  if (textBlocks) console.log(textBlocks);
  else if (!imgBlocks.length) console.error('(no content in response)');
  else console.log(JSON.stringify({ note: 'image-only response', imageBlocks: imgBlocks.length }));
  child.kill();
  if (stderrBuf.trim()) console.error('SERVER_STDERR:\n' + stderrBuf.slice(-2000));
  process.exit(msg.result?.isError ? 3 : 0);
} catch (e) {
  console.error('CLIENT_ERROR: ' + e.message);
  child.kill();
  process.exit(1);
}
