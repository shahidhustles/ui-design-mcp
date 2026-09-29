import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { registerUiResource, GALLERY_URI, UI_META } from '../src/ui.js';
import { registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { toolResult } from '../src/tools/common.js';
import { Script } from 'node:vm';

async function connectedServer(fn: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'ui-design-test', version: '0.0.0' });
  registerUiResource(server);
  fn(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ui-design-test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('MCP Apps UI resource', () => {
  it('defines the ui:// contract shared by all gallery tools', () => {
    expect(GALLERY_URI.startsWith('ui://')).toBe(true);
    expect(GALLERY_URI.endsWith('.html')).toBe(true);
    expect(UI_META).toEqual({ ui: { resourceUri: GALLERY_URI } });
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
  });

  it('serves the gallery HTML as a resource with the MCP Apps MIME type', async () => {
    const client = await connectedServer(() => {});
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(GALLERY_URI);
    const res = resources.find((r) => r.uri === GALLERY_URI);
    expect(res?.mimeType).toBe(RESOURCE_MIME_TYPE);

    const read = await client.readResource({ uri: GALLERY_URI });
    const item = read.contents[0];
    expect(item.mimeType).toBe(RESOURCE_MIME_TYPE);
    const html = String(item.text ?? '');
    // Sanity: it is the single-file vanilla app with the postMessage handshake.
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('ui/initialize');
    expect(html).toContain('ui/notifications/tool-result');
    expect(html).toContain('tools/call');
    expect(html).toContain('protocolVersion: \'2026-01-26\'');
    expect(html).toContain('Tool payload (text and images returned to the host)');
    expect(html).toContain('max-height: min(70vh, 580px)');
    expect(html).not.toContain('ui/update-model-context');
    expect(html).not.toContain('Send to model');
    expect(html).not.toContain('type="checkbox"');
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
    // No external asset origins — everything is inlined for default-deny CSP.
    expect(html).not.toContain('<link rel="stylesheet"');
    await client.close();
  });

  it('advertises the ui:// resource in resources/list with a CSP allowlist', async () => {
    const client = await connectedServer(() => {});
    const read = await client.readResource({ uri: GALLERY_URI });
    const item = read.contents[0] as {
      _meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
    };
    const csp = item?._meta?.ui?.csp;
    expect(csp?.resourceDomains).toContain('https://refero.design');
    await client.close();
  });
});

describe('tool result shape for the widget', () => {
  it('returns structuredContent alongside the JSON text block', () => {
    const payload = { type: 'screens', count: 1, results: [{ id: 'x:1' }] };
    const res = toolResult(payload, []);
    expect(res.structuredContent).toEqual(payload);
    const text = res.content.find((c) => c.type === 'text');
    expect(JSON.parse((text as { text: string }).text)).toEqual(payload);
  });
});

describe('app tool registration', () => {
  it('exposes an app tool that carries the UI meta and returns content', async () => {
    const client = await connectedServer((server) => {
      registerAppTool(
        server,
        'probe',
        {
          title: 'Probe',
          description: 'probe',
          inputSchema: { n: z.number().int() },
          _meta: UI_META,
        },
        async ({ n }) => toolResult({ n }),
      );
    });
    const { tools } = await client.listTools();
    const probe = tools.find((t) => t.name === 'probe') as
      | { _meta?: { ui?: { resourceUri?: string } } }
      | undefined;
    expect(probe?._meta?.ui?.resourceUri).toBe(GALLERY_URI);

    const res = (await client.callTool({ name: 'probe', arguments: { n: 7 } })) as {
      structuredContent?: { n?: number };
    };
    expect(res.structuredContent?.n).toBe(7);
    await client.close();
  });
});
