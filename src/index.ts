import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { registerAdapter } from './adapters/adapter.js';
import { createAppleAdapter } from './adapters/apple-itunes.js';
import { createReferoAdapter } from './adapters/refero.js';
import { createScreensDesignAdapter } from './adapters/screensdesign/index.js';
import { MetadataStore } from './cache/metadata.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { registerGetAppTool } from './tools/get-app.js';
import { registerGetFlowsTool } from './tools/get-flows.js';
import { registerGetImageTool } from './tools/get-image.js';
import { registerListSourcesTool } from './tools/list-sources.js';
import { registerSearchAppsTool } from './tools/search-apps.js';
import { registerSearchScreensTool } from './tools/search-screens.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new MetadataStore(path.join(cfg.cacheDir, 'meta.sqlite'));

  registerAdapter(createReferoAdapter(store, cfg));
  registerAdapter(createScreensDesignAdapter(store, cfg));
  registerAdapter(createAppleAdapter(cfg));

  const server = new McpServer({ name: 'ui-design', version: '0.1.0' });
  registerSearchScreensTool(server, store, cfg);
  registerSearchAppsTool(server, store, cfg);
  registerGetAppTool(server, store, cfg);
  registerGetFlowsTool(server, store, cfg);
  registerGetImageTool(server, cfg);
  registerListSourcesTool(server, store, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ui-design MCP ready — cache: ${cfg.cacheDir}`);
}

process.on('unhandledRejection', (e) => {
  log('unhandledRejection:', e);
});

main().catch((e) => {
  log('fatal:', e);
  process.exit(1);
});
