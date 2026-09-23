import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { fetchBuffer } from '../http.js';

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.(jpe?g|png|webp|gif|avif|mp4)$/i);
    const ext = m?.[1];
    if (ext) {
      const normalized = ext.toLowerCase();
      return normalized === 'jpeg' ? 'jpg' : normalized;
    }
  } catch {
    // not a URL — fall through
  }
  return 'bin';
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
};

/** Content-addressed path: `<cacheDir>/cache/<source>/<sha1(url)>.<ext>`. */
export function imageCachePath(cacheDir: string, source: string, url: string): string {
  const sha1 = createHash('sha1').update(url).digest('hex');
  return path.join(cacheDir, 'cache', source, `${sha1}.${extFromUrl(url)}`);
}

/**
 * Return the local path for `url`, downloading once if not cached.
 * Atomic write via `.part` + rename so a crashed download never leaves a
 * half file masquerading as a cache hit.
 */
export async function ensureImage(source: string, url: string, cfg: Config): Promise<string> {
  const dest = imageCachePath(cfg.cacheDir, source, url);
  if (existsSync(dest)) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  const buf = await fetchBuffer(source, url, cfg);
  const part = `${dest}.part`;
  writeFileSync(part, buf);
  renameSync(part, dest);
  return dest;
}

/** Read a cached file as base64 with a mime type derived from its extension. */
export function readImage(file: string): { data: string; mimeType: string } {
  const buf = readFileSync(file);
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return { data: buf.toString('base64'), mimeType: mime };
}
