/**
 * Canvas MCP - Cloudflare Workers Entry Point
 * Remote MCP server for Canvas LMS and Gradescope
 * Uses Streamable HTTP transport
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CanvasApi } from "./canvas-api.js";
import { GradescopeApi } from "./gradescope-api.js";
import { WorkerCache } from "./cache.js";
import { Logger } from "./config.js";

// Environment bindings type
export interface Env {
  CANVAS_API_KEY?: string;
  CANVAS_BASE_URL?: string;
  GRADESCOPE_EMAIL?: string;
  GRADESCOPE_PASSWORD?: string;
  DEBUG?: string;
}

// Runtime config (merged from env vars and request params)
interface RuntimeConfig {
  canvasApiKey: string;
  canvasBaseUrl: string;
  gradescopeEmail?: string;
  gradescopePassword?: string;
  debug: boolean;
}

// Extract config from request (Smithery passes config via query params or headers)
function getConfigFromRequest(request: Request, env: Env): RuntimeConfig {
  const url = new URL(request.url);
  
  // Try query parameters first (Smithery session config)
  const canvasApiKey = url.searchParams.get("canvasApiKey") || 
                       url.searchParams.get("canvas_api_key") ||
                       request.headers.get("x-canvas-api-key") ||
                       env.CANVAS_API_KEY || "";
  
  const canvasBaseUrl = url.searchParams.get("canvasBaseUrl") || 
                        url.searchParams.get("canvas_base_url") ||
                        request.headers.get("x-canvas-base-url") ||
                        env.CANVAS_BASE_URL || "https://canvas.asu.edu";
  
  const gradescopeEmail = url.searchParams.get("gradescopeEmail") || 
                          url.searchParams.get("gradescope_email") ||
                          request.headers.get("x-gradescope-email") ||
                          env.GRADESCOPE_EMAIL;
  
  const gradescopePassword = url.searchParams.get("gradescopePassword") || 
                             url.searchParams.get("gradescope_password") ||
                             request.headers.get("x-gradescope-password") ||
                             env.GRADESCOPE_PASSWORD;
  
  const debug = url.searchParams.get("debug") === "true" || env.DEBUG === "true";

  return { canvasApiKey, canvasBaseUrl, gradescopeEmail, gradescopePassword, debug };
}

// Tool definitions with handlers
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

// Create tools for the MCP server
function createTools(config: RuntimeConfig): ToolDefinition[] {
  const logger = new Logger(config.debug);
  const cache = new WorkerCache();

  const canvasApi = new CanvasApi({
    apiKey: config.canvasApiKey,
    baseUrl: config.canvasBaseUrl,
    logger,
    cache,
  });

  const hasCanvasConfig = Boolean(config.canvasApiKey);

  let gradescopeApi: GradescopeApi | null = null;
  if (config.gradescopeEmail && config.gradescopePassword) {
    gradescopeApi = new GradescopeApi({
      email: config.gradescopeEmail,
      password: config.gradescopePassword,
      logger,
      cache,
    });
  }

  const tools: ToolDefinition[] = [
    {
      name: "get_courses",
      description: "Retrieve all available Canvas courses for the current user. Returns a dictionary mapping course names to their corresponding IDs.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured. Set CANVAS_API_KEY to enable Canvas tools." }] };
        }
        const courses = await canvasApi.getCourses();
        return { content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses" }] };
      },
    },
    {
      name: "get_modules",
      description: "Retrieve all modules within a specific Canvas course.",
      inputSchema: {
        type: "object",
        properties: { course_id: { type: "string", description: "The Canvas course ID" } },
        required: ["course_id"],
      },
      handler: async ({ course_id }: { course_id: string }) => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const modules = await canvasApi.getModules(course_id);
        return { content: [{ type: "text", text: modules ? JSON.stringify(modules, null, 2) : "Failed to retrieve modules" }] };
      },
    },
    {
      name: "get_module_items",
      description: "Retrieve all items within a specific module in a Canvas course.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The Canvas course ID" },
          module_id: { type: "string", description: "The Canvas module ID" },
        },
        required: ["course_id", "module_id"],
      },
      handler: async ({ course_id, module_id }: { course_id: string; module_id: string }) => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const items = await canvasApi.getModuleItems(course_id, module_id);
        return { content: [{ type: "text", text: items ? JSON.stringify(items, null, 2) : "Failed to retrieve module items" }] };
      },
    },
    {
      name: "get_file_url",
      description: "Get the direct download URL for a file stored in Canvas.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The Canvas course ID" },
          file_id: { type: "string", description: "The Canvas file ID" },
        },
        required: ["course_id", "file_id"],
      },
      handler: async ({ course_id, file_id }: { course_id: string; file_id: string }) => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const url = await canvasApi.getFileUrl(course_id, file_id);
        return { content: [{ type: "text", text: url || "Failed to retrieve file URL" }] };
      },
    },
    {
      name: "get_course_assignments",
      description: "Retrieve all assignments for a specific Canvas course.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The Canvas course ID" },
          bucket: { type: "string", description: "Filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future" },
        },
        required: ["course_id"],
      },
      handler: async ({ course_id, bucket }: { course_id: string; bucket?: string }) => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const assignments = await canvasApi.getCourseAssignments(course_id, bucket);
        return { content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }] };
      },
    },
    {
      name: "get_assignments_by_course_name",
      description: "Retrieve all assignments for a Canvas course using its name.",
      inputSchema: {
        type: "object",
        properties: {
          course_name: { type: "string", description: "The course name (partial matches supported)" },
          bucket: { type: "string", description: "Filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future" },
        },
        required: ["course_name"],
      },
      handler: async ({ course_name, bucket }: { course_name: string; bucket?: string }) => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const assignments = await canvasApi.getAssignmentsByCourseName(course_name, bucket);
        return { content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }] };
      },
    },
    {
      name: "get_canvas_courses",
      description: "Alias for get_courses - retrieve all Canvas courses.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!hasCanvasConfig) {
          return { content: [{ type: "text", text: "Canvas is not configured." }] };
        }
        const courses = await canvasApi.getCourses();
        return { content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses" }] };
      },
    },
    {
      name: "get_cache_stats",
      description: "Get cache statistics for debugging.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const stats = cache.getStats();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      },
    },
    {
      name: "clear_cache",
      description: "Clear all cached data.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        cache.clear();
        return { content: [{ type: "text", text: "Cache cleared successfully" }] };
      },
    },
  ];

  // Add Gradescope tools if configured
  if (gradescopeApi) {
    const gsApi = gradescopeApi;
    tools.push(
      {
        name: "get_gradescope_courses",
        description: "Retrieve all Gradescope courses for the current user.",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: async () => {
          const courses = await gsApi.getGradescopeCourses();
          return { content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve Gradescope courses" }] };
        },
      },
      {
        name: "get_gradescope_course_by_name",
        description: "Find a Gradescope course by name.",
        inputSchema: {
          type: "object",
          properties: { course_name: { type: "string", description: "The course name to search for" } },
          required: ["course_name"],
        },
        handler: async ({ course_name }: { course_name: string }) => {
          const course = await gsApi.getGradescopeCourseByName(course_name);
          return { content: [{ type: "text", text: course ? JSON.stringify(course, null, 2) : "Course not found" }] };
        },
      },
      {
        name: "get_gradescope_assignments",
        description: "Retrieve all assignments for a Gradescope course.",
        inputSchema: {
          type: "object",
          properties: { course_id: { type: "string", description: "The Gradescope course ID" } },
          required: ["course_id"],
        },
        handler: async ({ course_id }: { course_id: string }) => {
          const assignments = await gsApi.getGradescopeAssignments(course_id);
          return { content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }] };
        },
      },
      {
        name: "get_gradescope_assignment_by_name",
        description: "Find a Gradescope assignment by name.",
        inputSchema: {
          type: "object",
          properties: {
            course_id: { type: "string", description: "The Gradescope course ID" },
            assignment_name: { type: "string", description: "The assignment name to search for" },
          },
          required: ["course_id", "assignment_name"],
        },
        handler: async ({ course_id, assignment_name }: { course_id: string; assignment_name: string }) => {
          const assignment = await gsApi.getGradescopeAssignmentByName(course_id, assignment_name);
          return { content: [{ type: "text", text: assignment ? JSON.stringify(assignment, null, 2) : "Assignment not found" }] };
        },
      }
    );
  }

  logger.log(`Canvas MCP Server: ${tools.length} tools available`);
  return tools;
}

// Smithery Server Card
const SERVER_CARD = {
  serverInfo: { name: "Canvas MCP", version: "1.1.0" },
  authentication: { required: false, schemes: [] },
  tools: [
    { name: "get_courses", description: "Retrieve all Canvas courses", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "get_modules", description: "Retrieve modules for a course", inputSchema: { type: "object", properties: { course_id: { type: "string" } }, required: ["course_id"] } },
    { name: "get_module_items", description: "Retrieve items within a module", inputSchema: { type: "object", properties: { course_id: { type: "string" }, module_id: { type: "string" } }, required: ["course_id", "module_id"] } },
    { name: "get_file_url", description: "Get download URL for a file", inputSchema: { type: "object", properties: { course_id: { type: "string" }, file_id: { type: "string" } }, required: ["course_id", "file_id"] } },
    { name: "get_course_assignments", description: "Retrieve assignments for a course", inputSchema: { type: "object", properties: { course_id: { type: "string" }, bucket: { type: "string" } }, required: ["course_id"] } },
    { name: "get_assignments_by_course_name", description: "Retrieve assignments by course name", inputSchema: { type: "object", properties: { course_name: { type: "string" }, bucket: { type: "string" } }, required: ["course_name"] } },
    { name: "get_canvas_courses", description: "Alias for get_courses", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "get_gradescope_courses", description: "Retrieve Gradescope courses", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "get_gradescope_course_by_name", description: "Find Gradescope course by name", inputSchema: { type: "object", properties: { course_name: { type: "string" } }, required: ["course_name"] } },
    { name: "get_gradescope_assignments", description: "Retrieve Gradescope assignments", inputSchema: { type: "object", properties: { course_id: { type: "string" } }, required: ["course_id"] } },
    { name: "get_gradescope_assignment_by_name", description: "Find Gradescope assignment by name", inputSchema: { type: "object", properties: { course_id: { type: "string" }, assignment_name: { type: "string" } }, required: ["course_id", "assignment_name"] } },
    { name: "get_cache_stats", description: "Get cache statistics", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "clear_cache", description: "Clear cached data", inputSchema: { type: "object", properties: {}, required: [] } },
  ],
  resources: [],
  prompts: [],
};

// Session storage
interface Session {
  tools: ToolDefinition[];
}
const sessions = new Map<string, Session>();

// Handle JSON-RPC messages
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
          serverInfo: { name: "Canvas and Gradescope MCP", version: "1.1.0" },
        },
      };
    }

    if (method === "notifications/initialized") {
      // Client acknowledges initialization - no response needed for notifications
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

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    // Unknown method
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

// Export the Worker handler
export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: (promise: Promise<any>) => void }): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Smithery server card
    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Canvas MCP Server",
          version: "1.1.0",
          description: "MCP server for Canvas LMS and Gradescope",
          endpoints: { sse: "/sse", mcp: "/mcp" },
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // MCP endpoints
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      // Get runtime config from request (supports Smithery session config)
      const config = getConfigFromRequest(request, env);
      
      // GET - SSE stream
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

      // POST - JSON-RPC
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
        
        // Filter out null responses (notifications don't need responses)
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

      // DELETE - Close session
      if (request.method === "DELETE") {
        const sessionId = request.headers.get("Mcp-Session-Id");
        if (sessionId) {
          sessions.delete(sessionId);
        }
        return new Response(null, { status: 204, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
