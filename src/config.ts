/**
 * Configuration management for Canvas MCP
 * Compatible with Cloudflare Workers runtime
 */

import { z } from "zod";

// Configuration schema validation
export const configSchema = z.object({
  debug: z.boolean().default(false).describe("Enable debug logging"),
  canvasApiKey: z
    .string()
    .default("")
    .describe(
      "Canvas API key. Optional; if omitted, Canvas tools will explain how to configure."
    ),
  canvasBaseUrl: z
    .string()
    .default("https://canvas.asu.edu")
    .describe("Canvas base URL"),
  gradescopeEmail: z.string().optional().describe("Gradescope email"),
  gradescopePassword: z.string().optional().describe("Gradescope password"),
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
