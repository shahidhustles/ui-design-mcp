import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../src/config.js';
import { registerSaveReferencesTool, saveReferences } from '../src/tools/save-references.js';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-design-save-'));
  const project = path.join(root, 'project');
  const cache = path.join(root, 'cache-root');
  await mkdir(project);
  await mkdir(path.join(cache, 'cache', 'refero'), { recursive: true });
  return { root, project, cache, cfg: loadConfig({ UIMCP_CACHE_DIR: cache }) };
}

describe('save_references', () => {
  it('copies selected cached flow screens in order and leaves unrelated media out', async () => {
    const { project, cache, cfg } = await fixture();
    const first = path.join(cache, 'cache', 'refero', 'welcome.png');
    const second = path.join(cache, 'cache', 'refero', 'permissions.png');
    await writeFile(first, Buffer.from('first image'));
    await writeFile(second, Buffer.from('second image'));

    const result = await saveReferences(project, 'references/onboarding', [
      { url: pathToFileURL(first).href, title: 'Welcome screen' },
      { url: pathToFileURL(second).href, title: 'Permissions screen' },
    ], cfg);

    expect(result.failed).toEqual([]);
    expect(result.saved.map((s) => path.basename(s.path))).toEqual([
      expect.stringMatching(/^01-welcome-screen-.+\.png$/),
      expect.stringMatching(/^02-permissions-screen-.+\.png$/),
    ]);
    expect(await readFile(result.saved[0]!.path, 'utf8')).toBe('first image');
    expect(await readFile(result.saved[1]!.path, 'utf8')).toBe('second image');
    expect((await readdir(result.directory)).length).toBe(2);
  });

  it('streams a selected video and reports a failed item without losing the saved one', async () => {
    const { project, cfg } = await fixture();
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.endsWith('.mp4')
      ? new Response(Buffer.from('video bytes'), { headers: { 'content-type': 'video/mp4' } })
      : new Response('<html>no media</html>', { headers: { 'content-type': 'text/html' } })));

    const result = await saveReferences(project, 'references/flow', [
      { url: 'https://media.example.com/session.mp4', title: 'Session recording' },
      { url: 'https://media.example.com/error', title: 'Bad media' },
    ], cfg);

    expect(result.saved, JSON.stringify(result.failed)).toHaveLength(1);
    expect(result.saved[0]?.mimeType).toBe('video/mp4');
    expect(await readFile(result.saved[0]!.path, 'utf8')).toBe('video bytes');
    expect(result.failed).toEqual([{ url: 'https://media.example.com/error', error: 'unsupported media type: text/html' }]);
    expect((await readdir(result.directory)).some((name) => name.endsWith('.part'))).toBe(false);
  });

  it('keeps output inside the chosen project and cached input inside the MCP cache', async () => {
    const { root, project, cfg } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'x.png'), 'outside image');
    await expect(saveReferences(project, '../outside', [{ url: 'https://media.example.com/x.png' }], cfg))
      .rejects.toThrow('folder must be a relative path');
    await symlink(outside, path.join(project, 'linked'));
    await expect(saveReferences(project, 'linked/references', [{ url: 'https://media.example.com/x.png' }], cfg))
      .rejects.toThrow('folder resolves outside projectRoot');
    expect(await readdir(outside)).toEqual(['x.png']);

    const result = await saveReferences(project, 'references', [
      { url: pathToFileURL(path.join(root, 'outside', 'x.png')).href },
    ], cfg);
    expect(result.saved).toEqual([]);
    expect(result.failed[0]?.error).toContain('outside the MCP media cache');
  });

  it('is exposed as a model-callable MCP tool without a gallery resource', async () => {
    const { project, cache, cfg } = await fixture();
    const image = path.join(cache, 'cache', 'refero', 'screen.png');
    await writeFile(image, 'screen image');
    const server = new McpServer({ name: 'save-test', version: '1.0.0' });
    registerSaveReferencesTool(server, cfg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'save-test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const save = listed.tools.find((tool) => tool.name === 'save_references');
    expect(save).toBeTruthy();
    expect(save?._meta?.ui).toBeUndefined();
    const result = await client.callTool({
      name: 'save_references',
      arguments: { projectRoot: project, folder: 'references', items: [{ url: pathToFileURL(image).href }] },
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { saved: unknown[] }).saved).toHaveLength(1);
    await client.close();
  });
});
