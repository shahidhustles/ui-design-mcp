import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.rateLimitMs).toBe(500);
    expect(cfg.maxResults).toBe(24);
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.fakeOffline).toBe(false);
    expect(cfg.catalogTtlDays).toBe(7);
  });

  it('reads env overrides', () => {
    const cfg = loadConfig({
      UIMCP_RATE_LIMIT_MS: '120',
      UIMCP_MAX_RESULTS: '3',
      UIMCP_FAKE_OFFLINE: '1',
      UIMCP_CACHE_DIR: '/tmp/uimcp-data',
    } as NodeJS.ProcessEnv);
    expect(cfg.rateLimitMs).toBe(120);
    expect(cfg.maxResults).toBe(3);
    expect(cfg.fakeOffline).toBe(true);
    expect(cfg.cacheDir).toBe('/tmp/uimcp-data');
  });

  it('falls back on garbage values', () => {
    const cfg = loadConfig({ UIMCP_RATE_LIMIT_MS: 'abc' } as NodeJS.ProcessEnv);
    expect(cfg.rateLimitMs).toBe(500);
  });
});
