import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { registerAdapter } from './adapters/adapter.js';
import { createAppleAdapter } from './adapters/apple-itunes.js';
import { createNicelyDoneAdapter } from './adapters/nicelydone/index.js';
import { createPttrnsAdapter } from './adapters/pttrns.js';
import { createReferoAdapter } from './adapters/refero.js';
import { createScreensDesignAdapter } from './adapters/screensdesign/index.js';
import { createSimpleAppShipperAdapter } from './adapters/simpleappshipper.js';
import { MetadataStore } from './cache/metadata.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { registerFindComponentsTool } from './tools/find-components.js';
import { registerGetAppTool } from './tools/get-app.js';
import { registerGetFlowsTool } from './tools/get-flows.js';
import { registerGetImageTool } from './tools/get-image.js';
import { registerGetOnboardingTool } from './tools/get-onboarding.js';
import { registerListSourcesTool } from './tools/list-sources.js';
import { registerSearchTool } from './tools/search.js';
import { registerSaveReferencesTool } from './tools/save-references.js';
import { registerUiResource } from './ui.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new MetadataStore(path.join(cfg.cacheDir, 'meta.sqlite'));

  registerAdapter(createReferoAdapter(store, cfg));
  registerAdapter(createScreensDesignAdapter(store, cfg));
  registerAdapter(createAppleAdapter(cfg));
  registerAdapter(createNicelyDoneAdapter(store, cfg));
  registerAdapter(createPttrnsAdapter(store, cfg));
  registerAdapter(createSimpleAppShipperAdapter(store, cfg));

  const server = new McpServer({ name: 'ui-design', version: '0.3.0' });
  registerUiResource(server);
  registerSearchTool(server, store, cfg);
  registerGetAppTool(server, store, cfg);
  registerGetFlowsTool(server, store, cfg);
  registerGetImageTool(server, cfg);
  registerListSourcesTool(server, store, cfg);
  registerGetOnboardingTool(server, store, cfg);
  registerFindComponentsTool(server, store, cfg);
  registerSaveReferencesTool(server, cfg);

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
