import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GALLERY_HTML } from './app/gallery.js';

/** UI resource every gallery tool points at (MCP Apps, io.modelcontextprotocol/ui). */
export const GALLERY_URI = 'ui://ui-design/gallery.html';

/** Tool-definition _meta that links a tool to the gallery UI. */
export const UI_META: Record<string, unknown> = { ui: { resourceUri: GALLERY_URI } };

/**
 * Same host allowlist as get-image.ts sourceForUrl, used only as the direct-
 * <img>/<video> fallback when the postMessage bridge is unavailable.
 */
const RESOURCE_DOMAINS = [
  'https://refero.design',
  'https://*.refero.design',
  'https://screensdesign.com',
  'https://api.screensdesign.com',
  'https://mzstatic.com',
  'https://*.mzstatic.com',
  'https://apple.com',
  'https://*.apple.com',
  'https://nicelydone.club',
  'https://*.nicelydone.club',
  'https://simpleappshipper.com',
  'https://*.simpleappshipper.com',
  'https://website-files.com',
  'https://*.website-files.com',
  'https://*.b-cdn.net', // ScreensDesign 720p session recordings
];

/**
 * Register the single gallery UI resource. Hosts that negotiate the
 * io.modelcontextprotocol/ui extension render it in a sandboxed iframe when a
 * linked tool is called; other clients never see it.
 */
export function registerUiResource(server: McpServer): void {
  registerAppResource(
    server,
    'ui-design gallery',
    GALLERY_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: GALLERY_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: GALLERY_HTML,
          _meta: {
            ui: {
              csp: {
                resourceDomains: RESOURCE_DOMAINS,
                connectDomains: [],
                frameDomains: [],
              },
            },
          },
        },
      ],
    }),
  );
}
