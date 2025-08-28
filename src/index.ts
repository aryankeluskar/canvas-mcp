/**
 * Canvas LMS and Gradescope MCP Server
 * Comprehensive implementation replicating Python canvas.py and gradescope.py functionality
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfig, configSchema, Logger } from "./config.js";
import { CanvasApi } from "./canvas-api.js";
import { GradescopeApi } from "./gradescope-api.js";
import { cache } from "./cache.js";

export { configSchema };

export default function createStatelessServer({
  config,
  sessionId,
}: {
  config: z.infer<typeof configSchema>;
  sessionId: string;
}) {
  const server = new McpServer({
    name: "Canvas and Gradescope MCP",
    version: "1.0.0",
  });

  // Initialize logger and APIs
  const logger = new Logger(config.debug);
  const canvasApi = new CanvasApi({
    apiKey: config.canvasApiKey,
    baseUrl: config.canvasBaseUrl,
    logger
  });

  // Initialize Gradescope API only if credentials are provided
  let gradescopeApi: GradescopeApi | null = null;
  if (config.gradescopeEmail && config.gradescopePassword) {
    gradescopeApi = new GradescopeApi({
      email: config.gradescopeEmail,
      password: config.gradescopePassword,
      logger
    });
  }

  // ==== CANVAS API TOOLS ====

  // Tool 1: Get Canvas courses
  server.tool(
    "get_courses",
    "Use this tool to retrieve all available Canvas courses for the current user. This tool returns a dictionary mapping course names to their corresponding IDs. Use this when you need to find course IDs based on names, display all available courses, or when needing to access any course-related information.",
    {},
    async () => {
      try {
        const courses = await canvasApi.getCourses();
        return {
          content: [{ 
            type: "text", 
            text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses"
          }]
        };
      } catch (error) {
        logger.error("Error in get_courses:", error);
        return {
          content: [{ type: "text", text: "Error retrieving courses" }]
        };
      }
    }
  );

  // Tool 2: Get Canvas modules
  server.tool(
    "get_modules",
    "Use this tool to retrieve all modules within a specific Canvas course. This tool returns a list of module objects containing module details like ID, name, and status. Use this when exploring or navigating course content structure.",
    {
      course_id: z.string().describe("The Canvas course ID")
    },
    async ({ course_id }) => {
      try {
        const modules = await canvasApi.getModules(course_id);
        return {
          content: [{ 
            type: "text", 
            text: modules ? JSON.stringify(modules, null, 2) : "Failed to retrieve modules"
          }]
        };
      } catch (error) {
        logger.error("Error in get_modules:", error);
        return {
          content: [{ type: "text", text: "Error retrieving modules" }]
        };
      }
    }
  );

  // Tool 3: Get module items
  server.tool(
    "get_module_items",
    "Use this tool to retrieve all items within a specific module in a Canvas course. This tool returns a list of module item objects containing details like title, type, and URLs. Use this when you need to access specific learning materials, assignments, or other content within a module.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      module_id: z.string().describe("The Canvas module ID")
    },
    async ({ course_id, module_id }) => {
      try {
        const items = await canvasApi.getModuleItems(course_id, module_id);
        return {
          content: [{ 
            type: "text", 
            text: items ? JSON.stringify(items, null, 2) : "Failed to retrieve module items"
          }]
        };
      } catch (error) {
        logger.error("Error in get_module_items:", error);
        return {
          content: [{ type: "text", text: "Error retrieving module items" }]
        };
      }
    }
  );

  // Tool 4: Get file URL
  server.tool(
    "get_file_url",
    "Use this tool to get the direct download URL for a file stored in Canvas. This tool returns a URL string that can be used to access or download the file. Use this when you need direct access to file content rather than just the Canvas page URL.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      file_id: z.string().describe("The Canvas file ID")
    },
    async ({ course_id, file_id }) => {
      try {
        const url = await canvasApi.getFileUrl(course_id, file_id);
        return {
          content: [{ 
            type: "text", 
            text: url || "Failed to retrieve file URL"
          }]
        };
      } catch (error) {
        logger.error("Error in get_file_url:", error);
        return {
          content: [{ type: "text", text: "Error retrieving file URL" }]
        };
      }
    }
  );

  // Tool 5: Get course assignments
  server.tool(
    "get_course_assignments",
    "Use this tool to retrieve all assignments for a specific Canvas course, with optional filtering by status. This tool returns assignment details including name, description, due date, and submission status. Use this when helping users manage their coursework, check due dates, or find assignment details.",
    {
      course_id: z.string().describe("The Canvas course ID"),
      bucket: z.string().optional().describe("Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future")
    },
    async ({ course_id, bucket }) => {
      try {
        const assignments = await canvasApi.getCourseAssignments(course_id, bucket);
        return {
          content: [{ 
            type: "text", 
            text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments"
          }]
        };
      } catch (error) {
        logger.error("Error in get_course_assignments:", error);
        return {
          content: [{ type: "text", text: "Error retrieving assignments" }]
        };
      }
    }
  );

  // Tool 6: Get assignments by course name
  server.tool(
    "get_assignments_by_course_name",
    "Use this tool to retrieve all assignments for a Canvas course using its name rather than ID. This tool returns assignment details the same as get_course_assignments. Use this when you have the course name but not the ID, or when helping users find assignments across multiple courses.",
    {
      course_name: z.string().describe("The name of the course as it appears in Canvas (partial matches supported)"),
      bucket: z.string().optional().describe("Optional filter - past, overdue, undated, ungraded, unsubmitted, upcoming, future")
    },
    async ({ course_name, bucket }) => {
      try {
        const assignments = await canvasApi.getAssignmentsByCourseName(course_name, bucket);
        return {
          content: [{ 
            type: "text", 
            text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments"
          }]
        };
      } catch (error) {
        logger.error("Error in get_assignments_by_course_name:", error);
        return {
          content: [{ type: "text", text: "Error retrieving assignments" }]
        };
      }
    }
  );

  // Tool 7: Get Canvas courses (alias)
  server.tool(
    "get_canvas_courses",
    "Use this tool to retrieve all available Canvas courses for the current user. This is an alias for get_courses. Use this when you need to find course IDs based on names or display all available courses.",
    {},
    async () => {
      try {
        const courses = await canvasApi.getCourses();
        return {
          content: [{ 
            type: "text", 
            text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve courses"
          }]
        };
      } catch (error) {
        logger.error("Error in get_canvas_courses:", error);
      return {
          content: [{ type: "text", text: "Error retrieving courses" }]
        };
      }
    }
  );

  // ==== GRADESCOPE API TOOLS ====

  if (gradescopeApi) {
    // Tool 8: Get Gradescope courses
    server.tool(
      "get_gradescope_courses",
      "Use this tool to retrieve all available Gradescope courses for the current user. This tool returns a dictionary of courses organized by user role. Use this when helping users access or manage their Gradescope course information.",
      {
        random_string: z.string().default("").describe("Dummy parameter for no-parameter tools")
      },
      async () => {
        try {
          const courses = await gradescopeApi!.getGradescopeCourses();
          return {
            content: [{ 
              type: "text", 
              text: courses ? JSON.stringify(courses, null, 2) : "Failed to retrieve Gradescope courses"
            }]
          };
        } catch (error) {
          logger.error("Error in get_gradescope_courses:", error);
          return {
            content: [{ type: "text", text: "Error retrieving Gradescope courses" }]
          };
        }
      }
    );

    // Tool 9: Get Gradescope course by name
    server.tool(
      "get_gradescope_course_by_name",
      "Use this tool to find a specific Gradescope course by name (partial matches supported). This tool returns the course object if found. Use this when you need to get course details or ID when only the name is known.",
      {
        course_name: z.string().describe("The name or partial name of the Gradescope course to search for")
      },
      async ({ course_name }) => {
        try {
          const course = await gradescopeApi!.getGradescopeCourseByName(course_name);
          return {
            content: [{ 
              type: "text", 
              text: course ? JSON.stringify(course, null, 2) : "Course not found"
            }]
          };
        } catch (error) {
          logger.error("Error in get_gradescope_course_by_name:", error);
          return {
            content: [{ type: "text", text: "Error retrieving Gradescope course" }]
          };
        }
      }
    );

    // Tool 10: Get Gradescope assignments
    server.tool(
      "get_gradescope_assignments",
      "Use this tool to retrieve all assignments for a specific Gradescope course, including the student's submission information (grades, status, due dates). This tool returns comprehensive assignment and submission details for the authenticated student. Use this when helping students manage their Gradescope coursework.",
      {
        course_id: z.string().describe("The Gradescope course ID")
      },
      async ({ course_id }) => {
        try {
          const assignments = await gradescopeApi!.getGradescopeAssignments(course_id);
          return {
            content: [{ 
              type: "text", 
              text: assignments ? JSON.stringify(assignments, null, 2) : "Failed to retrieve assignments"
            }]
          };
        } catch (error) {
          logger.error("Error in get_gradescope_assignments:", error);
          return {
            content: [{ type: "text", text: "Error retrieving Gradescope assignments" }]
          };
        }
      }
    );

    // Tool 11: Get Gradescope assignment by name
    server.tool(
      "get_gradescope_assignment_by_name",
      "Use this tool to find a specific Gradescope assignment by name within a course. This tool returns the assignment object if found, including the student's submission information (grade, status, due dates). Use this when you need assignment details when only the name and course are known.",
      {
        course_id: z.string().describe("The Gradescope course ID"),
        assignment_name: z.string().describe("The name or partial name of the assignment to search for")
      },
      async ({ course_id, assignment_name }) => {
        try {
          const assignment = await gradescopeApi!.getGradescopeAssignmentByName(course_id, assignment_name);
          return {
            content: [{ 
              type: "text", 
              text: assignment ? JSON.stringify(assignment, null, 2) : "Assignment not found"
            }]
          };
        } catch (error) {
          logger.error("Error in get_gradescope_assignment_by_name:", error);
          return {
            content: [{ type: "text", text: "Error retrieving Gradescope assignment" }]
          };
        }
      }
    );

    // ==== UTILITY TOOLS ====

    // Cache statistics tool for debugging
    server.tool(
      "get_cache_stats",
      "Get statistics about the current cache state for debugging purposes",
      {},
      async () => {
        try {
          const stats = cache.getStats();
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(stats, null, 2)
            }]
          };
        } catch (error) {
          logger.error("Error in get_cache_stats:", error);
          return {
            content: [{ type: "text", text: "Error retrieving cache statistics" }]
          };
        }
      }
    );

    // Clear cache tool
    server.tool(
      "clear_cache",
      "Clear all cached data to force fresh API requests",
      {},
      async () => {
        try {
          cache.clear();
          return {
            content: [{ 
              type: "text", 
              text: "Cache cleared successfully"
            }]
          };
        } catch (error) {
          logger.error("Error in clear_cache:", error);
          return {
            content: [{ type: "text", text: "Error clearing cache" }]
          };
        }
      }
    );

  } else {
    logger.warn("Gradescope credentials not provided - Gradescope tools will not be available");
  }

  logger.log(`Canvas MCP Server initialized with ${gradescopeApi ? 'Canvas and Gradescope' : 'Canvas only'} support`);

  return server.server;
}
