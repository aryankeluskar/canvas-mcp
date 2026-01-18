/**
 * Canvas MCP - Entry Point
 * 
 * This project has been migrated to Cloudflare Workers.
 * The main entry point is now src/worker.ts
 * 
 * For local development: npm run dev
 * For deployment: npm run deploy
 * 
 * @see worker.ts for the main MCP server implementation
 */

export { default } from "./worker.js";
export * from "./worker.js";

// Re-export types for external use
export type { Env, CanvasMcpAgent } from "./worker.js";
export { configSchema } from "./config.js";
