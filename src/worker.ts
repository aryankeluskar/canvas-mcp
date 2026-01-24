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

// Decode Smithery's base64-encoded config parameter
function decodeSmitheryConfig(configParam: string): Record<string, any> {
  try {
    // Smithery passes config as base64-encoded JSON in a single "config" query param
    const decoded = atob(configParam);
    const parsed = JSON.parse(decoded);
    console.log("[Config] Decoded Smithery config:", JSON.stringify({
      ...parsed,
      canvasApiKey: parsed.canvasApiKey ? `${parsed.canvasApiKey.substring(0, 10)}...` : undefined,
      gradescopePassword: parsed.gradescopePassword ? "***" : undefined,
    }));
    return parsed;
  } catch (error) {
    console.error("[Config] Failed to decode Smithery config:", error);
    return {};
  }
}

// Extract config from request (Smithery passes config as base64-encoded JSON)
function getConfigFromRequest(request: Request, env: Env): RuntimeConfig {
  const url = new URL(request.url);
  
  // Check for Smithery's base64-encoded config parameter first
  const configParam = url.searchParams.get("config");
  let smitheryConfig: Record<string, any> = {};
  
  if (configParam) {
    smitheryConfig = decodeSmitheryConfig(configParam);
  }
  
  // Priority: Smithery config > individual query params > headers > env vars
  const canvasApiKey = smitheryConfig.canvasApiKey ||
                       url.searchParams.get("canvasApiKey") || 
                       url.searchParams.get("canvas_api_key") ||
                       request.headers.get("x-canvas-api-key") ||
                       env.CANVAS_API_KEY || "";
  
  const canvasBaseUrl = smitheryConfig.canvasBaseUrl ||
                        url.searchParams.get("canvasBaseUrl") || 
                        url.searchParams.get("canvas_base_url") ||
                        request.headers.get("x-canvas-base-url") ||
                        env.CANVAS_BASE_URL || "https://canvas.asu.edu";
  
  const gradescopeEmail = smitheryConfig.gradescopeEmail ||
                          url.searchParams.get("gradescopeEmail") || 
                          url.searchParams.get("gradescope_email") ||
                          request.headers.get("x-gradescope-email") ||
                          env.GRADESCOPE_EMAIL;
  
  const gradescopePassword = smitheryConfig.gradescopePassword ||
                             url.searchParams.get("gradescopePassword") || 
                             url.searchParams.get("gradescope_password") ||
                             request.headers.get("x-gradescope-password") ||
                             env.GRADESCOPE_PASSWORD;
  
  const debug = smitheryConfig.debug === true ||
                url.searchParams.get("debug") === "true" || 
                env.DEBUG === "true";

  console.log("[Config] Final config - canvasApiKey:", canvasApiKey ? `${canvasApiKey.substring(0, 10)}...` : "EMPTY");
  console.log("[Config] Final config - canvasBaseUrl:", canvasBaseUrl);

  return { canvasApiKey, canvasBaseUrl, gradescopeEmail, gradescopePassword, debug };
}

// Tool annotations per MCP spec
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Tool definitions with handlers
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations?: ToolAnnotations;
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
      annotations: {
        title: "Get Canvas Courses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
        properties: { 
          course_id: { 
            type: "string", 
            description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." 
          } 
        },
        required: ["course_id"],
      },
      annotations: {
        title: "Get Course Modules",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
          course_id: { 
            type: "string", 
            description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." 
          },
          module_id: { 
            type: "string", 
            description: "The unique identifier for the module within the course. Can be found via get_modules." 
          },
        },
        required: ["course_id", "module_id"],
      },
      annotations: {
        title: "Get Module Items",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
          course_id: { 
            type: "string", 
            description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." 
          },
          file_id: { 
            type: "string", 
            description: "The unique identifier for the file. Can be found in module items or file listings." 
          },
        },
        required: ["course_id", "file_id"],
      },
      annotations: {
        title: "Get File Download URL",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
          course_id: { 
            type: "string", 
            description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." 
          },
          bucket: { 
            type: "string", 
            description: "Optional filter for assignment status. Valid values: past, overdue, undated, ungraded, unsubmitted, upcoming, future." 
          },
        },
        required: ["course_id"],
      },
      annotations: {
        title: "Get Course Assignments",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
          course_name: { 
            type: "string", 
            description: "The name of the course to search for. Partial matches are supported (e.g., 'Biology' will match 'Introduction to Biology')." 
          },
          bucket: { 
            type: "string", 
            description: "Optional filter for assignment status. Valid values: past, overdue, undated, ungraded, unsubmitted, upcoming, future." 
          },
        },
        required: ["course_name"],
      },
      annotations: {
        title: "Get Assignments by Course Name",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      annotations: {
        title: "Get Canvas Courses (Alias)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        title: "Get Cache Statistics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => {
        const stats = cache.getStats();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      },
    },
    {
      name: "clear_cache",
      description: "Clear all cached data.",
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: {
        title: "Clear Cache",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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
        annotations: {
          title: "Get Gradescope Courses",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
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
          properties: { 
            course_name: { 
              type: "string", 
              description: "The name of the Gradescope course to search for. Partial matches are supported." 
            } 
          },
          required: ["course_name"],
        },
        annotations: {
          title: "Find Gradescope Course by Name",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
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
          properties: { 
            course_id: { 
              type: "string", 
              description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name." 
            } 
          },
          required: ["course_id"],
        },
        annotations: {
          title: "Get Gradescope Assignments",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
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
            course_id: { 
              type: "string", 
              description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name." 
            },
            assignment_name: { 
              type: "string", 
              description: "The name of the assignment to search for. Partial matches are supported." 
            },
          },
          required: ["course_id", "assignment_name"],
        },
        annotations: {
          title: "Find Gradescope Assignment by Name",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
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

// Smithery Server Card with configuration schema
const SERVER_CARD = {
  serverInfo: { name: "Canvas MCP", version: "1.1.0" },
  authentication: { required: false, schemes: [] },
  // Configuration schema for Smithery to generate OAuth UI form
  // x-from tells Smithery where to pass each config value
  configurationSchema: {
    type: "object",
    properties: {
      canvasApiKey: {
        type: "string",
        description: "Your Canvas API key (Personal Access Token from Canvas settings). Required for Canvas tools.",
        "x-from": { query: "canvasApiKey" },
      },
      canvasBaseUrl: {
        type: "string",
        description: "Your Canvas instance URL (e.g., https://canvas.instructure.com)",
        default: "https://canvas.asu.edu",
        "x-from": { query: "canvasBaseUrl" },
      },
      gradescopeEmail: {
        type: "string",
        description: "Gradescope login email. Required (along with password) for Gradescope tools.",
        "x-from": { query: "gradescopeEmail" },
      },
      gradescopePassword: {
        type: "string",
        description: "Gradescope password. Required (along with email) for Gradescope tools.",
        "x-from": { query: "gradescopePassword" },
      },
    },
    required: ["canvasApiKey"],
  },
  tools: [
    { 
      name: "get_courses", 
      description: "Retrieve all available Canvas courses for the current user. Returns a dictionary mapping course names to their corresponding IDs.", 
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: { title: "Get Canvas Courses", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_modules", 
      description: "Retrieve all modules within a specific Canvas course.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." } 
        }, 
        required: ["course_id"] 
      },
      annotations: { title: "Get Course Modules", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_module_items", 
      description: "Retrieve all items within a specific module in a Canvas course.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." }, 
          module_id: { type: "string", description: "The unique identifier for the module within the course. Can be found via get_modules." } 
        }, 
        required: ["course_id", "module_id"] 
      },
      annotations: { title: "Get Module Items", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_file_url", 
      description: "Get the direct download URL for a file stored in Canvas.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." }, 
          file_id: { type: "string", description: "The unique identifier for the file. Can be found in module items or file listings." } 
        }, 
        required: ["course_id", "file_id"] 
      },
      annotations: { title: "Get File Download URL", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_course_assignments", 
      description: "Retrieve all assignments for a specific Canvas course.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Canvas course. Can be found in the course URL or via get_courses." }, 
          bucket: { type: "string", description: "Optional filter for assignment status. Valid values: past, overdue, undated, ungraded, unsubmitted, upcoming, future." } 
        }, 
        required: ["course_id"] 
      },
      annotations: { title: "Get Course Assignments", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_assignments_by_course_name", 
      description: "Retrieve all assignments for a Canvas course using its name.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_name: { type: "string", description: "The name of the course to search for. Partial matches are supported (e.g., 'Biology' will match 'Introduction to Biology')." }, 
          bucket: { type: "string", description: "Optional filter for assignment status. Valid values: past, overdue, undated, ungraded, unsubmitted, upcoming, future." } 
        }, 
        required: ["course_name"] 
      },
      annotations: { title: "Get Assignments by Course Name", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_canvas_courses", 
      description: "Alias for get_courses - retrieve all Canvas courses.", 
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: { title: "Get Canvas Courses (Alias)", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_gradescope_courses", 
      description: "Retrieve all Gradescope courses for the current user.", 
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: { title: "Get Gradescope Courses", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_gradescope_course_by_name", 
      description: "Find a Gradescope course by name.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_name: { type: "string", description: "The name of the Gradescope course to search for. Partial matches are supported." } 
        }, 
        required: ["course_name"] 
      },
      annotations: { title: "Find Gradescope Course by Name", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_gradescope_assignments", 
      description: "Retrieve all assignments for a Gradescope course.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name." } 
        }, 
        required: ["course_id"] 
      },
      annotations: { title: "Get Gradescope Assignments", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_gradescope_assignment_by_name", 
      description: "Find a Gradescope assignment by name.", 
      inputSchema: { 
        type: "object", 
        properties: { 
          course_id: { type: "string", description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name." }, 
          assignment_name: { type: "string", description: "The name of the assignment to search for. Partial matches are supported." } 
        }, 
        required: ["course_id", "assignment_name"] 
      },
      annotations: { title: "Find Gradescope Assignment by Name", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "get_cache_stats", 
      description: "Get cache statistics for debugging purposes. Returns hit/miss counts and cache size.", 
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: { title: "Get Cache Statistics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { 
      name: "clear_cache", 
      description: "Clear all cached data. Use this if you need fresh data from Canvas or Gradescope.", 
      inputSchema: { type: "object", properties: {}, required: [] },
      annotations: { title: "Clear Cache", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ],
  resources: [
    {
      uri: "canvas://courses",
      name: "Canvas Courses",
      description: "List of all Canvas courses for the authenticated user",
      mimeType: "application/json",
    },
    {
      uri: "gradescope://courses",
      name: "Gradescope Courses",
      description: "List of all Gradescope courses for the authenticated user",
      mimeType: "application/json",
    },
  ],
  prompts: [
    {
      name: "find_resources",
      description: "Navigate the Canvas hierarchy to find course resources (files, pages, assignments). Follow the order: get_courses -> get_modules -> get_module_items -> get_file_url",
      arguments: [
        {
          name: "resource_type",
          description: "Type of resource to find: file, assignment, page, or all",
          required: false,
        },
        {
          name: "course_name",
          description: "Optional course name to filter by",
          required: false,
        },
      ],
    },
    {
      name: "list_upcoming_assignments",
      description: "Get a summary of upcoming assignments across all courses",
      arguments: [
        {
          name: "days",
          description: "Number of days to look ahead (default: 7)",
          required: false,
        },
      ],
    },
    {
      name: "course_overview",
      description: "Get an overview of a specific course including modules and assignments",
      arguments: [
        {
          name: "course_name",
          description: "The name of the course to get an overview for",
          required: true,
        },
      ],
    },
  ],
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
          capabilities: { 
            tools: {},
            resources: {},
            prompts: {},
          },
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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: SERVER_CARD.resources,
        },
      };
    }

    if (method === "resources/read") {
      const uri = params?.uri;
      
      if (uri === "canvas://courses") {
        // Find the get_courses tool and execute it
        const tool = session.tools.find((t) => t.name === "get_courses");
        if (tool) {
          const result = await tool.handler({});
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [{ uri, mimeType: "application/json", text: result.content[0].text }],
            },
          };
        }
      }
      
      if (uri === "gradescope://courses") {
        const tool = session.tools.find((t) => t.name === "get_gradescope_courses");
        if (tool) {
          const result = await tool.handler({});
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [{ uri, mimeType: "application/json", text: result.content[0].text }],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ error: "Gradescope not configured" }) }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown resource: ${uri}` },
      };
    }

    if (method === "prompts/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          prompts: SERVER_CARD.prompts,
        },
      };
    }

    if (method === "prompts/get") {
      const promptName = params?.name;
      const promptArgs = params?.arguments || {};
      
      const prompt = SERVER_CARD.prompts.find((p) => p.name === promptName);
      if (!prompt) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown prompt: ${promptName}` },
        };
      }

      // Generate prompt messages based on the prompt type
      let messages: Array<{ role: string; content: { type: string; text: string } }> = [];
      
      if (promptName === "find_resources") {
        const resourceType = promptArgs.resource_type || "all";
        const courseName = promptArgs.course_name;
        const courseFilter = courseName ? ` in the course "${courseName}"` : " across all my courses";
        messages = [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please help me find ${resourceType === "all" ? "resources" : resourceType + "s"}${courseFilter}.

Follow this hierarchical navigation order:
1. **get_courses** - First, retrieve all available courses to get their IDs
2. **get_modules** - For each relevant course, get the list of modules using the course_id
3. **get_module_items** - For each module, retrieve the items (files, pages, assignments) using course_id and module_id
4. **get_file_url** - If looking for downloadable files, get the direct download URL using course_id and file_id

${resourceType === "assignment" ? "Also use **get_course_assignments** to get assignment details directly." : ""}

Present the results organized by course and module, showing the resource name, type, and any relevant details (due dates for assignments, download URLs for files).`,
            },
          },
        ];
      } else if (promptName === "list_upcoming_assignments") {
        const days = promptArgs.days || 7;
        messages = [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please list all my upcoming assignments due in the next ${days} days. First, get my courses from both Canvas and Gradescope (if configured), then retrieve assignments for each course and filter to show only those due within ${days} days. Organize them by due date.`,
            },
          },
        ];
      } else if (promptName === "course_overview") {
        const courseName = promptArgs.course_name || "unknown course";
        messages = [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please give me a complete overview of my course "${courseName}". Include:\n1. Course details and ID\n2. All modules and their items\n3. All assignments (upcoming and past)\n4. Any relevant files or resources\n\nCheck both Canvas and Gradescope for this course.`,
            },
          },
        ];
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: prompt.description,
          messages,
        },
      };
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

    // Health check (GET only)
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
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

    // MCP endpoints (also handle root path for Smithery proxy compatibility)
    if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/") {
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
