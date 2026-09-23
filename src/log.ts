/**
 * All logging goes to stderr — stdout is the MCP protocol stream.
 */
export function log(...args: unknown[]): void {
  console.error('[ui-design-mcp]', ...args);
}
