/**
 * Configuration management for Canvas MCP
 * Compatible with Cloudflare Workers runtime and Smithery
 */

import { z } from "zod";

// Configuration schema validation for Smithery
// See: https://smithery.ai/docs/build/session-config
export const configSchema = z.object({
  canvasApiKey: z
    .string()
    .describe("Your Canvas API key (Personal Access Token)")
    .meta({ "x-from": { query: "canvasApiKey" } }),
  canvasBaseUrl: z
    .string()
    .default("https://canvas.asu.edu")
    .describe("Canvas base URL (e.g., https://canvas.instructure.com)")
    .meta({ "x-from": { query: "canvasBaseUrl" } }),
  gradescopeEmail: z
    .string()
    .optional()
    .describe("Gradescope email (optional)")
    .meta({ "x-from": { query: "gradescopeEmail" } }),
  gradescopePassword: z
    .string()
    .optional()
    .describe("Gradescope password (optional)")
    .meta({ "x-from": { query: "gradescopePassword" } }),
  debug: z
    .boolean()
    .default(false)
    .describe("Enable debug logging")
    .meta({ "x-from": { query: "debug" } }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Logger utility with debug mode support
 * Compatible with Cloudflare Workers
 */
export class Logger {
  private debugMode: boolean;

  constructor(debug: boolean = false) {
    this.debugMode = debug;
  }

  log(...args: any[]): void {
    console.log("[Canvas-MCP]", ...args);
  }

  error(...args: any[]): void {
    console.error("[Canvas-MCP ERROR]", ...args);
  }

  debug(...args: any[]): void {
    if (this.debugMode) {
      console.log("[Canvas-MCP DEBUG]", ...args);
    }
  }

  warn(...args: any[]): void {
    console.warn("[Canvas-MCP WARN]", ...args);
  }
}
