/**
 * Configuration management for Canvas MCP
 * Compatible with Cloudflare Workers runtime and Smithery
 * 
 * Smithery automatically reads config from query params matching field names
 * See: https://smithery.ai/docs/build/session-config
 */

import { z } from "zod";

// Configuration schema for Smithery session config
// Field names become query parameter names automatically
export const configSchema = z.object({
  canvasApiKey: z
    .string()
    .describe("Your Canvas API key (Personal Access Token from Canvas settings)"),
  canvasBaseUrl: z
    .string()
    .default("https://canvas.asu.edu")
    .describe("Your Canvas instance URL (e.g., https://canvas.instructure.com)"),
  gradescopeEmail: z
    .string()
    .optional()
    .describe("Gradescope login email (optional)"),
  gradescopePassword: z
    .string()
    .optional()
    .describe("Gradescope password (optional)"),
  debug: z
    .boolean()
    .default(false)
    .describe("Enable debug logging"),
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
