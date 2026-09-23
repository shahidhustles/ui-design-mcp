import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageCachePath, readImage } from '../src/cache/images.js';

describe('image cache', () => {
  it('is content-addressed and deterministic', () => {
    const url = 'https://images.refero.design/screenshots/x/0.jpg';
    const p1 = imageCachePath('/data', 'refero', url);
    const p2 = imageCachePath('/data', 'refero', url);
    expect(p1).toBe(p2);
    expect(path.basename(p1)).toMatch(/^[a-f0-9]{40}\.jpg$/);
    expect(p1).toContain(path.join('cache', 'refero'));
    expect(imageCachePath('/data', 'refero', 'https://x.test/noext')).toMatch(/\.bin$/);
    expect(imageCachePath('/data', 'refero', 'https://x.test/a.jpeg')).toMatch(/\.jpg$/);
    expect(imageCachePath('/data', 'refero', 'https://x.test/b.mp4')).toMatch(/\.mp4$/);
  });
});

describe('readImage', () => {
  let dir: string;
  let jpg: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-img-'));
    jpg = path.join(dir, 'img.jpg');
    writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps extension to mime and returns base64', () => {
    const out = readImage(jpg);
    expect(out.mimeType).toBe('image/jpeg');
    expect(Buffer.from(out.data, 'base64').equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(true);
  });
});
