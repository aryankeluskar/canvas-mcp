/**
 * Canvas MCP - Cloudflare Workers Entry Point
 * Remote MCP server for Canvas LMS and Gradescope
 * Uses Streamable HTTP transport (MCP 2025-03-26 spec)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// Create and configure the MCP server
function createMcpServer(env: Env): McpServer {
  const debug = env.DEBUG === "true";
  const logger = new Logger(debug);
  const cache = new WorkerCache();

  const server = new McpServer({
    name: "Canvas and Gradescope MCP",
    version: "1.1.0",
  });

  // Initialize Canvas API
  const canvasApi = new CanvasApi({
    apiKey: env.CANVAS_API_KEY || "",
    baseUrl: env.CANVAS_BASE_URL || "https://canvas.asu.edu",
    logger,
    cache,
  });

  const hasCanvasConfig = Boolean(env.CANVAS_API_KEY);

  // Initialize Gradescope API if credentials provided
  let gradescopeApi: GradescopeApi | null = null;
  if (env.GRADESCOPE_EMAIL && env.GRADESCOPE_PASSWORD) {
    gradescopeApi = new GradescopeApi({
      email: env.GRADESCOPE_EMAIL,
      password: env.GRADESCOPE_PASSWORD,
      logger,
      cache,
    });
  }

  // ==== CANVAS API TOOLS ====

  server.tool(
    "get_courses",
    "Use this tool to retrieve all available Canvas courses for the current user. Returns a dictionary mapping course names to their corresponding IDs.",
    {},
    async () => {
      if (!hasCanvasConfig) {
        return {
          content: [{ type: "text", text: "Canvas is not configured. Set CANVAS_API_KEY to enable Canvas tools." }],
        };
      }
      const courses = await canvasApi.getCourses();
      return {
        content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses" }],
      };
    }
  );

  server.tool(
    "get_modules",
    "Retrieve all modules within a specific Canvas course.",
    { course_id: z.string().describe("The Canvas course ID") },
    async ({ course_id }) => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const modules = await canvasApi.getModules(course_id);
      return {
        content: [{ type: "text", text: modules ? JSON.stringify(modules, null, 2) : "Failed to retrieve modules" }],
      };
    }
  );

  server.tool(
    "get_module_items",
    "Retrieve all items within a specific module in a Canvas course.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      module_id: z.string().describe("The Canvas module ID"),
    },
    async ({ course_id, module_id }) => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const items = await canvasApi.getModuleItems(course_id, module_id);
      return {
        content: [{ type: "text", text: items ? JSON.stringify(items, null, 2) : "Failed to retrieve module items" }],
      };
    }
  );

  server.tool(
    "get_file_url",
    "Get the direct download URL for a file stored in Canvas.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      file_id: z.string().describe("The Canvas file ID"),
    },
    async ({ course_id, file_id }) => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const url = await canvasApi.getFileUrl(course_id, file_id);
      return { content: [{ type: "text", text: url || "Failed to retrieve file URL" }] };
    }
  );

  server.tool(
    "get_course_assignments",
    "Retrieve all assignments for a specific Canvas course.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      bucket: z.string().optional().describe("Filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future"),
    },
    async ({ course_id, bucket }) => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const assignments = await canvasApi.getCourseAssignments(course_id, bucket);
      return {
        content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }],
      };
    }
  );

  server.tool(
    "get_assignments_by_course_name",
    "Retrieve all assignments for a Canvas course using its name.",
    {
      course_name: z.string().describe("The course name (partial matches supported)"),
      bucket: z.string().optional().describe("Filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future"),
    },
    async ({ course_name, bucket }) => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const assignments = await canvasApi.getAssignmentsByCourseName(course_name, bucket);
      return {
        content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }],
      };
    }
  );

  server.tool(
    "get_canvas_courses",
    "Alias for get_courses - retrieve all Canvas courses.",
    {},
    async () => {
      if (!hasCanvasConfig) {
        return { content: [{ type: "text", text: "Canvas is not configured." }] };
      }
      const courses = await canvasApi.getCourses();
      return {
        content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses" }],
      };
    }
  );

  // ==== GRADESCOPE API TOOLS ====

  if (gradescopeApi) {
    const gsApi = gradescopeApi;

    server.tool(
      "get_gradescope_courses",
      "Retrieve all Gradescope courses for the current user.",
      {},
      async () => {
        const courses = await gsApi.getGradescopeCourses();
        return {
          content: [{ type: "text", text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve Gradescope courses" }],
        };
      }
    );

    server.tool(
      "get_gradescope_course_by_name",
      "Find a Gradescope course by name.",
      { course_name: z.string().describe("The course name to search for") },
      async ({ course_name }) => {
        const course = await gsApi.getGradescopeCourseByName(course_name);
        return {
          content: [{ type: "text", text: course ? JSON.stringify(course, null, 2) : "Course not found" }],
        };
      }
    );

    server.tool(
      "get_gradescope_assignments",
      "Retrieve all assignments for a Gradescope course.",
      { course_id: z.string().describe("The Gradescope course ID") },
      async ({ course_id }) => {
        const assignments = await gsApi.getGradescopeAssignments(course_id);
        return {
          content: [{ type: "text", text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments" }],
        };
      }
    );

    server.tool(
      "get_gradescope_assignment_by_name",
      "Find a Gradescope assignment by name.",
      {
        course_id: z.string().describe("The Gradescope course ID"),
        assignment_name: z.string().describe("The assignment name to search for"),
      },
      async ({ course_id, assignment_name }) => {
        const assignment = await gsApi.getGradescopeAssignmentByName(course_id, assignment_name);
        return {
          content: [{ type: "text", text: assignment ? JSON.stringify(assignment, null, 2) : "Assignment not found" }],
        };
      }
    );
  }

  // ==== UTILITY TOOLS ====

  server.tool(
    "get_cache_stats",
    "Get cache statistics for debugging.",
    {},
    async () => {
      const stats = cache.getStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    "clear_cache",
    "Clear all cached data.",
    {},
    async () => {
      cache.clear();
      return { content: [{ type: "text", text: "Cache cleared successfully" }] };
    }
  );

  logger.log(`Canvas MCP Server initialized with ${gradescopeApi ? "Canvas and Gradescope" : "Canvas only"} support`);

  return server;
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

// Session storage for SSE connections
const sessions = new Map<string, { server: McpServer; messages: any[] }>();

// Handle JSON-RPC message
async function handleMessage(server: McpServer, message: any): Promise<any> {
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

    if (method === "tools/list") {
      const tools = await server.server.listTools();
      return { jsonrpc: "2.0", id, result: tools };
    }

    if (method === "tools/call") {
      const result = await server.server.callTool(params.name, params.arguments || {});
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
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message || "Internal error" },
    };
  }
}

// Export the Worker handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // MCP Streamable HTTP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      // GET - SSE stream for notifications (optional, we return empty for now)
      if (request.method === "GET") {
        const sessionId = request.headers.get("Mcp-Session-Id") || crypto.randomUUID();
        
        // Create new session if needed
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, { server: createMcpServer(env), messages: [] });
        }

        // Return SSE stream
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // Send initial connection event
        writer.write(encoder.encode(`event: open\ndata: {"sessionId":"${sessionId}"}\n\n`));

        // Keep connection alive with periodic pings
        const pingInterval = setInterval(async () => {
          try {
            await writer.write(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(pingInterval);
          }
        }, 30000);

        // Clean up on close
        ctx.waitUntil(
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 300000)); // 5 min timeout
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

      // POST - Handle JSON-RPC messages
      if (request.method === "POST") {
        let sessionId = request.headers.get("Mcp-Session-Id");
        
        // Create new session if needed
        if (!sessionId || !sessions.has(sessionId)) {
          sessionId = crypto.randomUUID();
          sessions.set(sessionId, { server: createMcpServer(env), messages: [] });
        }

        const session = sessions.get(sessionId)!;
        const body = await request.json();

        // Handle single message or batch
        const messages = Array.isArray(body) ? body : [body];
        const responses = await Promise.all(messages.map((msg) => handleMessage(session.server, msg)));

        const result = Array.isArray(body) ? responses : responses[0];

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
