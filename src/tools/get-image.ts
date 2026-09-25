import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { ensureImage, readImage } from '../cache/images.js';
import type { Config } from '../config.js';
import { errorResult, toolResult } from './common.js';

/** Map an image host to its cache source dir so existing cache files are reused. */
export function sourceForUrl(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return 'web';
  }
  if (host.includes('screensdesign.com')) return 'screensdesign';
  if (host.includes('refero.design')) return 'refero';
  if (host.includes('mzstatic.com') || host.endsWith('apple.com')) return 'apple';
  if (host.includes('nicelydone.club')) return 'nicelydone';
  if (host.includes('simpleappshipper.com')) return 'simpleappshipper';
  // cdn.prod.website-files.com is Pttrns' Webflow CDN (site id in the path).
  if (host.includes('website-files.com')) return 'pttrns';
  return 'web';
}

interface Served {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/**
 * Serve a cached image, optionally transcoding (webp → png/jpeg, for
 * readers that can't render webp) and downscaling. Falls back to the raw
 * bytes if sharp is unavailable.
 */
export async function serve(
  file: string,
  format: 'auto' | 'png' | 'jpeg',
  maxDim: number,
  notes: string[],
): Promise<Served> {
  const raw = readImage(file);
  const ext = file.split('.').pop() ?? '';
  const needsTranscode = format !== 'auto' && (format === 'png' ? ext !== 'png' : ext !== 'jpg' && ext !== 'jpeg');
  if (!needsTranscode && maxDim <= 0) return { data: raw.data, mimeType: raw.mimeType };
  try {
    const sharp = (await import('sharp')).default;
    let img = sharp(readFileSync(file));
    const meta = await img.metadata();
    if (maxDim > 0) {
      img = img.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    const out = format === 'jpeg' ? await img.jpeg({ quality: 88 }).toBuffer() : await img.png().toBuffer();
    const finalMeta = await sharp(out).metadata();
    return {
      data: out.toString('base64'),
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: finalMeta.width,
      height: finalMeta.height,
    };
  } catch (e) {
    notes.push(`sharp unavailable (${e instanceof Error ? e.message : String(e)}) — serving original ${raw.mimeType}`);
    return { data: raw.data, mimeType: raw.mimeType };
  }
}

export function registerGetImageTool(server: McpServer, cfg: Config): void {
  server.registerTool(
    'get_image',
    {
      title: 'Get image',
      description:
        'Fetch one screenshot as an inline image block — use this instead of a Read tool, which often ' +
        'cannot render webp. Accepts http(s) imageUrls or file:// cachedUrls from search_screens / get_app. ' +
        'format "png"|"jpeg" transcodes; maxDim downscales (default 1600px).',
      inputSchema: {
        url: z.string().describe('http(s) image URL, or a file:// path from a cachedUrls entry'),
        format: z.enum(['auto', 'png', 'jpeg']).optional().default('auto').describe('Transcode to png/jpeg (webp → png)'),
        maxDim: z
          .number()
          .int()
          .min(256)
          .max(4096)
          .default(1600)
          .describe('Downscale so the longest side is at most this many px (default 1600)'),
      },
    },
    async ({ url, format, maxDim }: { url: string; format: 'auto' | 'png' | 'jpeg'; maxDim: number }) => {
      try {
        const notes: string[] = [];
        let file: string;
        if (url.startsWith('file://')) {
          file = url.slice('file://'.length);
          if (!existsSync(file)) return errorResult(`cached file not found: ${file}`);
        } else {
          file = await ensureImage(sourceForUrl(url), url, cfg);
        }
        const served = await serve(file, format, maxDim, notes);
        const bytes = Math.round((Buffer.byteLength(served.data, 'base64') * 3) / 4);
        return toolResult(
          {
            url,
            file: `file://${file}`,
            mimeType: served.mimeType,
            bytes,
            width: served.width ?? null,
            height: served.height ?? null,
            notes,
          },
          [{ data: served.data, mimeType: served.mimeType }],
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
