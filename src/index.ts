/**
 * Canvas MCP - Entry Point
 * 
 * This project runs on Cloudflare Workers.
 * The main entry point is src/worker.ts
 * 
 * For local development: npm run dev
 * For deployment: npm run deploy
 */

export { default } from "./worker.js";
export type { Env } from "./worker.js";
export { configSchema } from "./config.js";
