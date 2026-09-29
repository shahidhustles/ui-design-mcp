import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { Config } from '../config.js';
import { errorResult, toolResult } from './common.js';

const MAX_ITEMS = 30;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
);
EXT_MIME.jpeg = 'image/jpeg';

export interface ReferenceItem {
  url: string;
  title?: string;
}

export interface SavedReference {
  url: string;
  path: string;
  mimeType: string;
  bytes: number;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourcePath(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  const parsed = new URL(url);
  if (parsed.hostname) throw new Error('file URLs must refer to local cached media');
  const file = decodeURIComponent(parsed.pathname);
  return file;
}

function publicMediaUrl(url: string): URL {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !host ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      isIP(host) || !host.includes('.')) {
    throw new Error('remote media must use a public HTTPS hostname');
  }
  return parsed;
}

async function fetchPublicMedia(url: string): Promise<Response> {
  let current = publicMediaUrl(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('media redirect has no location');
    current = publicMediaUrl(new URL(location, current).href);
  }
  throw new Error('too many media redirects');
}

function mediaType(url: string, header?: string | null): { mimeType: string; ext: string; maxBytes: number } {
  const mime = header?.split(';')[0]?.trim().toLowerCase() || '';
  let ext = MIME_EXT[mime];
  let mimeType = mime;
  if (!ext && (!mime || mime === 'application/octet-stream')) {
    ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    mimeType = EXT_MIME[ext] || '';
  }
  if (!ext || !mimeType || (!mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) {
    throw new Error(`unsupported media type: ${mime || 'unknown'}`);
  }
  return { mimeType, ext, maxBytes: mimeType.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES };
}

function safeName(title: string | undefined, index: number, url: string, ext: string): string {
  const slug = (title || 'reference').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'reference';
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 10);
  return `${String(index + 1).padStart(2, '0')}-${slug}-${hash}.${ext}`;
}

async function destination(projectRoot: string, folder: string): Promise<string> {
  if (!path.isAbsolute(projectRoot)) throw new Error('projectRoot must be an absolute path');
  const root = await realpath(projectRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('projectRoot must be a directory');
  const parts = folder.split(/[\\/]/).filter(Boolean);
  if (!parts.length || path.isAbsolute(folder) || parts.some((part) => part === '..' || part === '.')) {
    throw new Error('folder must be a relative path inside projectRoot');
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!inside(root, current)) throw new Error('folder is outside projectRoot');
    try {
      await mkdir(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    current = await realpath(current);
    if (!inside(root, current)) throw new Error('folder resolves outside projectRoot');
  }
  return current;
}

async function saveOne(item: ReferenceItem, index: number, dir: string, cfg: Config): Promise<SavedReference> {
  const cached = sourcePath(item.url);
  let response: Response | undefined;
  let type: ReturnType<typeof mediaType>;
  if (cached) {
    const file = await realpath(cached);
    const cacheRoot = await realpath(path.resolve(cfg.cacheDir, 'cache'));
    if (!inside(cacheRoot, file)) throw new Error('cached file resolves outside the MCP media cache');
    type = mediaType(item.url);
  } else {
    response = await fetchPublicMedia(item.url);
    if (!response.ok || !response.body) throw new Error(`media download returned HTTP ${response.status}`);
    publicMediaUrl(response.url || item.url);
    type = mediaType(item.url, response.headers.get('content-type'));
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > type.maxBytes) throw new Error('media exceeds size limit');
  }

  const target = path.join(dir, safeName(item.title, index, item.url, type.ext));
  const temp = path.join(dir, `.ui-reference-${randomUUID()}.part`);
  try {
    if (cached) {
      const size = (await stat(cached)).size;
      if (size > type.maxBytes) throw new Error('media exceeds size limit');
      await copyFile(cached, temp, constants.COPYFILE_EXCL);
    } else {
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response!.body as import('node:stream/web').ReadableStream),
        new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > type.maxBytes ? new Error('media exceeds size limit') : null, chunk);
        } }),
        createWriteStream(temp, { flags: 'wx' }),
      );
    }
    try {
      await link(temp, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = await lstat(target);
      if (!existing.isFile()) throw new Error('existing reference path is not a regular file');
    }
    return { url: item.url, path: target, mimeType: type.mimeType, bytes: (await stat(target)).size };
  } finally {
    await unlink(temp).catch(() => {});
    await response?.body?.cancel().catch(() => {});
  }
}

export async function saveReferences(
  projectRoot: string,
  folder: string,
  items: ReferenceItem[],
  cfg: Config,
): Promise<{ directory: string; saved: SavedReference[]; failed: { url: string; error: string }[] }> {
  if (!items.length || items.length > MAX_ITEMS) throw new Error(`choose 1-${MAX_ITEMS} media items`);
  const dir = await destination(projectRoot, folder);
  const saved: SavedReference[] = [];
  const failed: { url: string; error: string }[] = [];
  for (const [index, item] of items.entries()) {
    try {
      saved.push(await saveOne(item, index, dir, cfg));
    } catch (e) {
      failed.push({ url: item.url, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { directory: dir, saved, failed };
}

export function registerSaveReferencesTool(server: McpServer, cfg: Config): void {
  server.registerTool(
    'save_references',
    {
      title: 'Save design references',
      description:
        'When the user asks to keep design references locally, choose the relevant subset of images/videos and save them into the project being worked on. ' +
        'Pass the absolute project root, a relative reference folder, and selected imageUrls, cachedUrls, or videoUrls ' +
        'from prior ui-design results. Preserve flow order in items. Returns saved absolute paths and per-item failures. ' +
        'Call when the user asks to keep references locally; the gallery itself never saves project files.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the existing project/repository being worked on'),
        folder: z.string().default('references/ui').describe('Relative folder within projectRoot'),
        items: z.array(z.object({
          url: z.string().describe('Image URL, cached file:// URL, or video URL from a ui-design result'),
          title: z.string().optional().describe('Short semantic filename, e.g. onboarding-welcome'),
        })).min(1).max(MAX_ITEMS).describe('Only the references worth keeping, in display/flow order'),
      },
    },
    async ({ projectRoot, folder, items }) => {
      try {
        return toolResult(await saveReferences(projectRoot, folder, items, cfg));
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
