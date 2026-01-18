/**
 * Canvas MCP - Cloudflare Workers Entry Point
 * Remote MCP server for Canvas LMS and Gradescope
 */

import { McpAgent } from "agents/mcp";
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
  // Optional KV for persistent cache
  CANVAS_CACHE?: KVNamespace;
}

// MCP Agent for Canvas
export class CanvasMcpAgent extends McpAgent<Env, {}, {}> {
  server = new McpServer({
    name: "Canvas and Gradescope MCP",
    version: "1.1.0",
  });

  private canvasApi!: CanvasApi;
  private gradescopeApi: GradescopeApi | null = null;
  private logger!: Logger;
  private cache!: WorkerCache;

  async init() {
    const env = this.env;
    const debug = env.DEBUG === "true";
    this.logger = new Logger(debug);
    this.cache = new WorkerCache();

    // Initialize Canvas API
    this.canvasApi = new CanvasApi({
      apiKey: env.CANVAS_API_KEY || "",
      baseUrl: env.CANVAS_BASE_URL || "https://canvas.asu.edu",
      logger: this.logger,
      cache: this.cache,
    });

    const hasCanvasConfig = Boolean(env.CANVAS_API_KEY);

    // Initialize Gradescope API if credentials provided
    if (env.GRADESCOPE_EMAIL && env.GRADESCOPE_PASSWORD) {
      this.gradescopeApi = new GradescopeApi({
        email: env.GRADESCOPE_EMAIL,
        password: env.GRADESCOPE_PASSWORD,
        logger: this.logger,
        cache: this.cache,
      });
    }

    // ==== CANVAS API TOOLS ====

    // Tool 1: Get Canvas courses
    this.server.tool(
      "get_courses",
      "Use this tool to retrieve all available Canvas courses for the current user. This tool returns a dictionary mapping course names to their corresponding IDs. Use this when you need to find course IDs based on names, display all available courses, or when needing to access any course-related information.",
      {},
      async () => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Set CANVAS_API_KEY (and optionally CANVAS_BASE_URL) to enable Canvas tools.",
                },
              ],
            };
          }
          const courses = await this.canvasApi.getCourses();
          return {
            content: [
              {
                type: "text",
                text: courses
                  ? JSON.stringify(courses, null, 2)
                  : "Failed to retrieve courses",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_courses:", error);
          return {
            content: [{ type: "text", text: "Error retrieving courses" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 2: Get Canvas modules
    this.server.tool(
      "get_modules",
      "Use this tool to retrieve all modules within a specific Canvas course. This tool returns a list of module objects containing module details like ID, name, and status. Use this when exploring or navigating course content structure.",
      z
        .object({
          course_id: z.string().describe("The Canvas course ID (required)"),
        })
        .describe(
          "Input object for get_modules. All fields are required unless marked optional."
        ),
      async ({ course_id }) => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Provide CANVAS_API_KEY to use get_modules.",
                },
              ],
            };
          }
          const modules = await this.canvasApi.getModules(course_id);
          return {
            content: [
              {
                type: "text",
                text: modules
                  ? JSON.stringify(modules, null, 2)
                  : "Failed to retrieve modules",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_modules:", error);
          return {
            content: [{ type: "text", text: "Error retrieving modules" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 3: Get module items
    this.server.tool(
      "get_module_items",
      "Use this tool to retrieve all items within a specific module in a Canvas course. This tool returns a list of module item objects containing details like title, type, and URLs. Use this when you need to access specific learning materials, assignments, or other content within a module.",
      z
        .object({
          course_id: z.string().describe("The Canvas course ID (required)"),
          module_id: z.string().describe("The Canvas module ID (required)"),
        })
        .describe(
          "Input object for get_module_items. All fields are required unless marked optional."
        ),
      async ({ course_id, module_id }) => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Provide CANVAS_API_KEY to use get_module_items.",
                },
              ],
            };
          }
          const items = await this.canvasApi.getModuleItems(course_id, module_id);
          return {
            content: [
              {
                type: "text",
                text: items
                  ? JSON.stringify(items, null, 2)
                  : "Failed to retrieve module items",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_module_items:", error);
          return {
            content: [{ type: "text", text: "Error retrieving module items" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 4: Get file URL
    this.server.tool(
      "get_file_url",
      "Use this tool to get the direct download URL for a file stored in Canvas. This tool returns a URL string that can be used to access or download the file. Use this when you need direct access to file content rather than just the Canvas page URL.",
      {
        course_id: z.string().describe("The Canvas course ID"),
        file_id: z.string().describe("The Canvas file ID"),
      },
      async ({ course_id, file_id }) => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Provide CANVAS_API_KEY to use get_file_url.",
                },
              ],
            };
          }
          const url = await this.canvasApi.getFileUrl(course_id, file_id);
          return {
            content: [
              {
                type: "text",
                text: url || "Failed to retrieve file URL",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_file_url:", error);
          return {
            content: [{ type: "text", text: "Error retrieving file URL" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 5: Get course assignments
    this.server.tool(
      "get_course_assignments",
      "Use this tool to retrieve all assignments for a specific Canvas course, with optional filtering by status. This tool returns assignment details including name, description, due date, and submission status. Use this when helping users manage their coursework, check due dates, or find assignment details.",
      {
        course_id: z.string().describe("The Canvas course ID"),
        bucket: z
          .string()
          .optional()
          .describe(
            "Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future"
          ),
      },
      async ({ course_id, bucket }) => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Provide CANVAS_API_KEY to use get_course_assignments.",
                },
              ],
            };
          }
          const assignments = await this.canvasApi.getCourseAssignments(
            course_id,
            bucket
          );
          return {
            content: [
              {
                type: "text",
                text: assignments
                  ? JSON.stringify(assignments, null, 2)
                  : "Failed to retrieve assignments",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_course_assignments:", error);
          return {
            content: [{ type: "text", text: "Error retrieving assignments" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 6: Get assignments by course name
    this.server.tool(
      "get_assignments_by_course_name",
      "Use this tool to retrieve all assignments for a Canvas course using its name rather than ID. This tool returns assignment details the same as get_course_assignments. Use this when you have the course name but not the ID, or when helping users find assignments across multiple courses.",
      {
        course_name: z
          .string()
          .describe(
            "The name of the course as it appears in Canvas (partial matches supported)"
          ),
        bucket: z
          .string()
          .optional()
          .describe(
            "Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future"
          ),
      },
      async ({ course_name, bucket }) => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Provide CANVAS_API_KEY to use get_assignments_by_course_name.",
                },
              ],
            };
          }
          const assignments = await this.canvasApi.getAssignmentsByCourseName(
            course_name,
            bucket
          );
          return {
            content: [
              {
                type: "text",
                text: assignments
                  ? JSON.stringify(assignments, null, 2)
                  : "Failed to retrieve assignments",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_assignments_by_course_name:", error);
          return {
            content: [{ type: "text", text: "Error retrieving assignments" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Tool 7: Get Canvas courses (alias)
    this.server.tool(
      "get_canvas_courses",
      "Use this tool to retrieve all available Canvas courses for the current user. This is an alias for get_courses. Use this when you need to find course IDs based on names or display all available courses.",
      {},
      async () => {
        try {
          if (!hasCanvasConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: "Canvas is not configured. Set CANVAS_API_KEY to enable Canvas tools.",
                },
              ],
            };
          }
          const courses = await this.canvasApi.getCourses();
          return {
            content: [
              {
                type: "text",
                text: courses
                  ? JSON.stringify(courses, null, 2)
                  : "Failed to retrieve courses",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_canvas_courses:", error);
          return {
            content: [{ type: "text", text: "Error retrieving courses" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // ==== GRADESCOPE API TOOLS ====

    if (this.gradescopeApi) {
      const gsApi = this.gradescopeApi;

      // Tool 8: Get Gradescope courses
      this.server.tool(
        "get_gradescope_courses",
        "Use this tool to retrieve all available Gradescope courses for the current user. This tool returns a dictionary of courses organized by user role. Use this when helping users access or manage their Gradescope course information.",
        {},
        async () => {
          try {
            const courses = await gsApi.getGradescopeCourses();
            return {
              content: [
                {
                  type: "text",
                  text: courses
                    ? JSON.stringify(courses, null, 2)
                    : "Failed to retrieve Gradescope courses",
                },
              ],
            };
          } catch (error) {
            this.logger.error("Error in get_gradescope_courses:", error);
            return {
              content: [
                { type: "text", text: "Error retrieving Gradescope courses" },
              ],
            };
          }
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        }
      );

      // Tool 9: Get Gradescope course by name
      this.server.tool(
        "get_gradescope_course_by_name",
        "Use this tool to find a specific Gradescope course by name (partial matches supported). This tool returns the course object if found. Use this when you need to get course details or ID when only the name is known.",
        {
          course_name: z
            .string()
            .describe(
              "The name or partial name of the Gradescope course to search for"
            ),
        },
        async ({ course_name }) => {
          try {
            const course = await gsApi.getGradescopeCourseByName(course_name);
            return {
              content: [
                {
                  type: "text",
                  text: course
                    ? JSON.stringify(course, null, 2)
                    : "Course not found",
                },
              ],
            };
          } catch (error) {
            this.logger.error("Error in get_gradescope_course_by_name:", error);
            return {
              content: [
                { type: "text", text: "Error retrieving Gradescope course" },
              ],
            };
          }
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        }
      );

      // Tool 10: Get Gradescope assignments
      this.server.tool(
        "get_gradescope_assignments",
        "Use this tool to retrieve all assignments for a specific Gradescope course, including the student's submission information (grades, status, due dates). This tool returns comprehensive assignment and submission details for the authenticated student. Use this when helping students manage their Gradescope coursework.",
        {
          course_id: z.string().describe("The Gradescope course ID"),
        },
        async ({ course_id }) => {
          try {
            const assignments = await gsApi.getGradescopeAssignments(course_id);
            return {
              content: [
                {
                  type: "text",
                  text: assignments
                    ? JSON.stringify(assignments, null, 2)
                    : "Failed to retrieve assignments",
                },
              ],
            };
          } catch (error) {
            this.logger.error("Error in get_gradescope_assignments:", error);
            return {
              content: [
                {
                  type: "text",
                  text: "Error retrieving Gradescope assignments",
                },
              ],
            };
          }
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        }
      );

      // Tool 11: Get Gradescope assignment by name
      this.server.tool(
        "get_gradescope_assignment_by_name",
        "Use this tool to find a specific Gradescope assignment by name within a course. This tool returns the assignment object if found, including the student's submission information (grade, status, due dates). Use this when you need assignment details when only the name and course are known.",
        {
          course_id: z.string().describe("The Gradescope course ID"),
          assignment_name: z
            .string()
            .describe(
              "The name or partial name of the assignment to search for"
            ),
        },
        async ({ course_id, assignment_name }) => {
          try {
            const assignment = await gsApi.getGradescopeAssignmentByName(
              course_id,
              assignment_name
            );
            return {
              content: [
                {
                  type: "text",
                  text: assignment
                    ? JSON.stringify(assignment, null, 2)
                    : "Assignment not found",
                },
              ],
            };
          } catch (error) {
            this.logger.error(
              "Error in get_gradescope_assignment_by_name:",
              error
            );
            return {
              content: [
                {
                  type: "text",
                  text: "Error retrieving Gradescope assignment",
                },
              ],
            };
          }
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        }
      );
    }

    // ==== UTILITY TOOLS ====

    // Cache statistics tool for debugging
    this.server.tool(
      "get_cache_stats",
      "Get statistics about the current cache state for debugging purposes",
      {},
      async () => {
        try {
          const stats = this.cache.getStats();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in get_cache_stats:", error);
          return {
            content: [
              { type: "text", text: "Error retrieving cache statistics" },
            ],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      }
    );

    // Clear cache tool
    this.server.tool(
      "clear_cache",
      "Clear all cached data to force fresh API requests",
      {},
      async () => {
        try {
          this.cache.clear();
          return {
            content: [
              {
                type: "text",
                text: "Cache cleared successfully",
              },
            ],
          };
        } catch (error) {
          this.logger.error("Error in clear_cache:", error);
          return {
            content: [{ type: "text", text: "Error clearing cache" }],
          };
        }
      },
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      }
    );

    this.logger.log(
      `Canvas MCP Server initialized with ${this.gradescopeApi ? "Canvas and Gradescope" : "Canvas only"} support`
    );
  }
}

// Smithery Server Card for discovery and publishing
const SERVER_CARD = {
  serverInfo: {
    name: "Canvas MCP",
    version: "1.1.0",
  },
  authentication: {
    required: false,
    schemes: [],
  },
  tools: [
    {
      name: "get_courses",
      description:
        "Retrieve all available Canvas courses for the current user. Returns a dictionary mapping course names to their corresponding IDs.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_modules",
      description:
        "Retrieve all modules within a specific Canvas course. Returns a list of module objects containing module details like ID, name, and status.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Canvas course ID (required)",
          },
        },
        required: ["course_id"],
      },
    },
    {
      name: "get_module_items",
      description:
        "Retrieve all items within a specific module in a Canvas course. Returns a list of module item objects containing details like title, type, and URLs.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Canvas course ID (required)",
          },
          module_id: {
            type: "string",
            description: "The Canvas module ID (required)",
          },
        },
        required: ["course_id", "module_id"],
      },
    },
    {
      name: "get_file_url",
      description:
        "Get the direct download URL for a file stored in Canvas. Returns a URL string that can be used to access or download the file.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Canvas course ID",
          },
          file_id: {
            type: "string",
            description: "The Canvas file ID",
          },
        },
        required: ["course_id", "file_id"],
      },
    },
    {
      name: "get_course_assignments",
      description:
        "Retrieve all assignments for a specific Canvas course, with optional filtering by status. Returns assignment details including name, description, due date, and submission status.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Canvas course ID",
          },
          bucket: {
            type: "string",
            description:
              "Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future",
          },
        },
        required: ["course_id"],
      },
    },
    {
      name: "get_assignments_by_course_name",
      description:
        "Retrieve all assignments for a Canvas course using its name rather than ID. Use this when you have the course name but not the ID.",
      inputSchema: {
        type: "object",
        properties: {
          course_name: {
            type: "string",
            description:
              "The name of the course as it appears in Canvas (partial matches supported)",
          },
          bucket: {
            type: "string",
            description:
              "Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future",
          },
        },
        required: ["course_name"],
      },
    },
    {
      name: "get_canvas_courses",
      description:
        "Retrieve all available Canvas courses for the current user. This is an alias for get_courses.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_gradescope_courses",
      description:
        "Retrieve all available Gradescope courses for the current user. Returns a dictionary of courses organized by user role.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_gradescope_course_by_name",
      description:
        "Find a specific Gradescope course by name (partial matches supported). Returns the course object if found.",
      inputSchema: {
        type: "object",
        properties: {
          course_name: {
            type: "string",
            description:
              "The name or partial name of the Gradescope course to search for",
          },
        },
        required: ["course_name"],
      },
    },
    {
      name: "get_gradescope_assignments",
      description:
        "Retrieve all assignments for a specific Gradescope course, including the student's submission information (grades, status, due dates).",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Gradescope course ID",
          },
        },
        required: ["course_id"],
      },
    },
    {
      name: "get_gradescope_assignment_by_name",
      description:
        "Find a specific Gradescope assignment by name within a course. Returns the assignment object if found.",
      inputSchema: {
        type: "object",
        properties: {
          course_id: {
            type: "string",
            description: "The Gradescope course ID",
          },
          assignment_name: {
            type: "string",
            description:
              "The name or partial name of the assignment to search for",
          },
        },
        required: ["course_id", "assignment_name"],
      },
    },
    {
      name: "get_cache_stats",
      description:
        "Get statistics about the current cache state for debugging purposes",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "clear_cache",
      description: "Clear all cached data to force fresh API requests",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
  resources: [],
  prompts: [],
};

// Export the Worker handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle Smithery server card endpoint
    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Handle SSE endpoint for MCP
    if (url.pathname === "/sse" || url.pathname === "/sse/") {
      return CanvasMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    // Handle MCP messages endpoint
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return CanvasMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    // Health check / info endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Canvas MCP Server",
          version: "1.1.0",
          description: "MCP server for Canvas LMS and Gradescope",
          endpoints: {
            sse: "/sse",
            mcp: "/mcp",
            serverCard: "/.well-known/mcp/server-card.json",
          },
          documentation: "https://github.com/aryankeluskar/canvas-mcp",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
