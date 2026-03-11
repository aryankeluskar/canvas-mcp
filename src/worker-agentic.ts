/**
 * Canvas MCP (Agentic Version) - Cloudflare Workers Entry Point
 *
 * This is the "agent-in-disguise" version of Canvas MCP. Instead of exposing
 * 8+ granular tools that require the client to traverse the Canvas hierarchy,
 * it exposes only 2 high-level tools backed by an embedded AI agent.
 *
 * The agent internally traverses Courses → Modules → Items → Files
 * and returns only the final result to the MCP client.
 */

import { CanvasApi } from "./canvas-api.js";
import { CanvasAgent } from "./agent.js";
import { WorkerCache } from "./cache.js";
import { Logger } from "./config.js";

export interface Env {
  CANVAS_API_KEY?: string;
  CANVAS_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  DEBUG?: string;
}

interface RuntimeConfig {
  canvasApiKey: string;
  canvasBaseUrl: string;
  openRouterApiKey: string;
  debug: boolean;
}

function decodeSmitheryConfig(configParam: string): Record<string, any> {
  try {
    const decoded = atob(configParam);
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function getConfigFromRequest(request: Request, env: Env): RuntimeConfig {
  const url = new URL(request.url);
  const configParam = url.searchParams.get("config");
  let smitheryConfig: Record<string, any> = {};
  if (configParam) {
    smitheryConfig = decodeSmitheryConfig(configParam);
  }

  return {
    canvasApiKey: smitheryConfig.canvasApiKey ||
                  url.searchParams.get("canvasApiKey") ||
                  url.searchParams.get("canvas_api_key") ||
                  request.headers.get("x-canvas-api-key") ||
                  env.CANVAS_API_KEY || "",
    canvasBaseUrl: smitheryConfig.canvasBaseUrl ||
                   url.searchParams.get("canvasBaseUrl") ||
                   url.searchParams.get("canvas_base_url") ||
                   request.headers.get("x-canvas-base-url") ||
                   env.CANVAS_BASE_URL || "https://canvas.asu.edu",
    openRouterApiKey: smitheryConfig.openRouterApiKey ||
                      url.searchParams.get("openRouterApiKey") ||
                      request.headers.get("x-openrouter-api-key") ||
                      env.OPENROUTER_API_KEY || "",
    debug: smitheryConfig.debug === true ||
           url.searchParams.get("debug") === "true" ||
           env.DEBUG === "true",
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations?: Record<string, any>;
  handler: (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createTools(config: RuntimeConfig): ToolDefinition[] {
  const logger = new Logger(config.debug);
  const cache = new WorkerCache();

  const canvasApi = new CanvasApi({
    apiKey: config.canvasApiKey,
    baseUrl: config.canvasBaseUrl,
    logger,
    cache,
  });

  const hasConfig = Boolean(config.canvasApiKey) && Boolean(config.openRouterApiKey);

  const agent = new CanvasAgent({
    openRouterApiKey: config.openRouterApiKey,
    canvasApi,
    logger,
  });

  const tools: ToolDefinition[] = [
    {
      name: "find_resources",
      description: `Find any resource (files, pages, documents, slides, links) across your Canvas courses.
Describe what you're looking for in natural language - the server will search through courses, modules, and items internally and return only the matching results.
Examples: "Find lecture slides for Linear Algebra", "Get all PDFs in my CS 101 course", "Find the syllabus for Data Structures"`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of what resource you're looking for. Include course name if known.",
          },
        },
        required: ["query"],
      },
      annotations: {
        title: "Find Canvas Resources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ query }: { query: string }) => {
        if (!hasConfig) {
          return {
            content: [{
              type: "text",
              text: "Canvas MCP Agent is not configured. Set CANVAS_API_KEY and OPENROUTER_API_KEY.",
            }],
          };
        }

        logger.log(`[Agent] find_resources query: "${query}"`);
        const { result, toolCallCount, turns } = await agent.run(
          `Find the following Canvas resource: ${query}\n\nTraverse the Canvas hierarchy (courses → modules → items) to find matching resources. Return file names, types, URLs, and any relevant metadata.`
        );

        logger.log(`[Agent] find_resources completed: ${toolCallCount} internal tool calls, ${turns} turns`);

        return {
          content: [{
            type: "text",
            text: `${result}\n\n---\n_Agent stats: ${toolCallCount} internal API calls, ${turns} reasoning turns_`,
          }],
        };
      },
    },
    {
      name: "find_assignments",
      description: `Find assignments across your Canvas courses. Search by course name, due date, status, or description.
Examples: "What assignments are due this week?", "List all overdue assignments", "Find homework for Calculus 2", "What's due in my CS classes?"`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of what assignments you're looking for.",
          },
        },
        required: ["query"],
      },
      annotations: {
        title: "Find Canvas Assignments",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ query }: { query: string }) => {
        if (!hasConfig) {
          return {
            content: [{
              type: "text",
              text: "Canvas MCP Agent is not configured. Set CANVAS_API_KEY and OPENROUTER_API_KEY.",
            }],
          };
        }

        logger.log(`[Agent] find_assignments query: "${query}"`);
        const { result, toolCallCount, turns } = await agent.run(
          `Find the following Canvas assignments: ${query}\n\nSearch through courses to find matching assignments. Return assignment names, due dates, points, and submission status. Today's date is ${new Date().toISOString().split('T')[0]}.`
        );

        logger.log(`[Agent] find_assignments completed: ${toolCallCount} internal tool calls, ${turns} turns`);

        return {
          content: [{
            type: "text",
            text: `${result}\n\n---\n_Agent stats: ${toolCallCount} internal API calls, ${turns} reasoning turns_`,
          }],
        };
      },
    },
    {
      name: "course_overview",
      description: `Get a comprehensive overview of a specific Canvas course including all modules, resources, and assignments.
Examples: "Give me an overview of Linear Algebra", "What's in my CS 340 course?", "Show me everything in Data Structures"`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The course name or description of what overview you want.",
          },
        },
        required: ["query"],
      },
      annotations: {
        title: "Canvas Course Overview",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ query }: { query: string }) => {
        if (!hasConfig) {
          return {
            content: [{
              type: "text",
              text: "Canvas MCP Agent is not configured. Set CANVAS_API_KEY and OPENROUTER_API_KEY.",
            }],
          };
        }

        logger.log(`[Agent] course_overview query: "${query}"`);
        const { result, toolCallCount, turns } = await agent.run(
          `Give a comprehensive overview of this Canvas course: ${query}\n\nGet the course details, list all modules and their items, and list all assignments with their due dates and status. Organize the overview clearly by module.`
        );

        logger.log(`[Agent] course_overview completed: ${toolCallCount} internal tool calls, ${turns} turns`);

        return {
          content: [{
            type: "text",
            text: `${result}\n\n---\n_Agent stats: ${toolCallCount} internal API calls, ${turns} reasoning turns_`,
          }],
        };
      },
    },
  ];

  return tools;
}

// Server card for the agentic version
const SERVER_CARD = {
  serverInfo: { name: "Canvas MCP (Agentic)", version: "2.0.0" },
  authentication: { required: false, schemes: [] },
  configurationSchema: {
    type: "object",
    properties: {
      canvasApiKey: {
        type: "string",
        description: "Your Canvas API key (Personal Access Token)",
        "x-from": { query: "canvasApiKey" },
      },
      canvasBaseUrl: {
        type: "string",
        description: "Your Canvas instance URL",
        default: "https://canvas.asu.edu",
        "x-from": { query: "canvasBaseUrl" },
      },
      openRouterApiKey: {
        type: "string",
        description: "OpenRouter API key for the embedded agent",
        "x-from": { query: "openRouterApiKey" },
      },
    },
    required: ["canvasApiKey", "openRouterApiKey"],
  },
  tools: [
    {
      name: "find_resources",
      description: "Find any resource (files, pages, documents) across Canvas courses using natural language.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { title: "Find Canvas Resources", readOnlyHint: true },
    },
    {
      name: "find_assignments",
      description: "Find assignments across Canvas courses using natural language.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { title: "Find Canvas Assignments", readOnlyHint: true },
    },
    {
      name: "course_overview",
      description: "Get a comprehensive overview of a Canvas course.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { title: "Canvas Course Overview", readOnlyHint: true },
    },
  ],
  resources: [],
  prompts: [],
};

// Session storage
interface Session {
  tools: ToolDefinition[];
}
const sessions = new Map<string, Session>();

async function handleMessage(session: Session, message: any): Promise<any> {
  const { method, params, id } = message;

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "Canvas MCP (Agentic)", version: "2.0.0" },
        },
      };
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: session.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        },
      };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      const tool = session.tools.find((t) => t.name === toolName);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
      }

      const result = await tool.handler(toolArgs);
      return { jsonrpc: "2.0", id, result };
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (error: any) {
    console.error(`Error handling ${method}:`, error);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message || "Internal error" },
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: (promise: Promise<any>) => void }): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "Canvas MCP Server (Agentic)",
          version: "2.0.0",
          description: "Agentic MCP server for Canvas LMS - uses an embedded AI agent to traverse hierarchies internally",
          tools: ["find_resources", "find_assignments", "course_overview"],
          architecture: "agent-in-disguise",
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/") {
      const config = getConfigFromRequest(request, env);

      if (request.method === "GET") {
        const sessionId = request.headers.get("Mcp-Session-Id") || crypto.randomUUID();
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, { tools: createTools(config) });
        }

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        writer.write(encoder.encode(`event: open\ndata: {"sessionId":"${sessionId}"}\n\n`));

        const pingInterval = setInterval(async () => {
          try {
            await writer.write(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(pingInterval);
          }
        }, 30000);

        ctx.waitUntil(
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 300000));
            clearInterval(pingInterval);
            writer.close();
          })()
        );

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Mcp-Session-Id": sessionId,
            ...corsHeaders,
          },
        });
      }

      if (request.method === "POST") {
        let sessionId = request.headers.get("Mcp-Session-Id");
        if (!sessionId || !sessions.has(sessionId)) {
          sessionId = crypto.randomUUID();
          sessions.set(sessionId, { tools: createTools(config) });
        }

        const session = sessions.get(sessionId)!;
        const body = await request.json();

        const messages = Array.isArray(body) ? body : [body];
        const responses = await Promise.all(messages.map((msg) => handleMessage(session, msg)));
        const filteredResponses = responses.filter((r) => r !== null);
        const result = Array.isArray(body) ? filteredResponses : filteredResponses[0];

        return new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
            ...corsHeaders,
          },
        });
      }

      if (request.method === "DELETE") {
        const sessionId = request.headers.get("Mcp-Session-Id");
        if (sessionId) sessions.delete(sessionId);
        return new Response(null, { status: 204, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
