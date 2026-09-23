import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { serve, sourceForUrl } from '../src/tools/get-image.js';

const dir = mkdtempSync(path.join(tmpdir(), 'uimcp-getimage-'));
const webpFile = path.join(dir, 'frame.webp');
const pngFile = path.join(dir, 'frame.png');

beforeAll(async () => {
  const base = sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 18, g: 18, b: 18 } },
  });
  await base.png().toFile(pngFile);
  await sharp(pngFile).webp().toFile(webpFile);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('sourceForUrl', () => {
  it('maps hosts to their cache source dirs', () => {
    expect(sourceForUrl('https://media.screensdesign.com/avs-pp/x.webp')).toBe('screensdesign');
    expect(sourceForUrl('https://api.refero.design/img/x.jpg')).toBe('refero');
    expect(sourceForUrl('https://is1-ssl.mzstatic.com/image/x.png')).toBe('apple');
    expect(sourceForUrl('https://cdn.some-other-site.com/x.png')).toBe('web');
  });
});

describe('serve', () => {
  it('serves webp raw when format=auto and no downscale needed', async () => {
    const out = await serve(webpFile, 'auto', 0, []);
    expect(out.mimeType).toBe('image/webp');
    expect(Buffer.from(out.data, 'base64').length).toBeGreaterThan(0);
  });

  it('transcodes webp → png', async () => {
    const out = await serve(webpFile, 'png', 0, []);
    expect(out.mimeType).toBe('image/png');
    const meta = await sharp(Buffer.from(out.data, 'base64')).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it('transcodes webp → jpeg and downscales to maxDim', async () => {
    const out = await serve(webpFile, 'jpeg', 50, []);
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.width).toBeLessThanOrEqual(50);
    expect(out.height).toBeLessThanOrEqual(50);
    // aspect preserved (2:1 → 50x25)
    expect(out.width).toBe(50);
    expect(out.height).toBe(25);
  });

  it('does not enlarge small images (withoutEnlargement)', async () => {
    const out = await serve(pngFile, 'png', 4000, []);
    expect(out.width).toBe(200);
    expect(out.height).toBe(100);
  });
});
