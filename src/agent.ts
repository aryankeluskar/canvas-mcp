/**
 * Embedded AI Agent for Canvas MCP
 *
 * This module implements an internal agent that traverses the Canvas LMS
 * hierarchy autonomously, so the MCP client only needs to make a single
 * high-level tool call instead of 4-5 sequential calls.
 *
 * Uses Kimi K2 via OpenRouter for cost-efficient tool calling.
 */

import { CanvasApi } from "./canvas-api.js";
import { Logger } from "./config.js";

interface AgentConfig {
  openRouterApiKey: string;
  canvasApi: CanvasApi;
  logger: Logger;
}

// The internal tools the agent can use to traverse Canvas
const CANVAS_AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_courses",
      description: "Get all Canvas courses. Returns a map of course names to IDs.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_modules",
      description: "Get all modules in a course. Requires course_id.",
      parameters: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
        },
        required: ["course_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_module_items",
      description: "Get all items (files, assignments, pages) in a module. Requires course_id and module_id.",
      parameters: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          module_id: { type: "string", description: "The module ID" },
        },
        required: ["course_id", "module_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_file_url",
      description: "Get the download URL for a specific file. Requires course_id and file_id.",
      parameters: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          file_id: { type: "string", description: "The file ID" },
        },
        required: ["course_id", "file_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_course_assignments",
      description: "Get all assignments for a course. Requires course_id. Optional bucket filter.",
      parameters: {
        type: "object",
        properties: {
          course_id: { type: "string", description: "The course ID" },
          bucket: { type: "string", description: "Filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future" },
        },
        required: ["course_id"],
      },
    },
  },
];

const AGENT_SYSTEM_PROMPT = `You are an internal agent embedded in a Canvas LMS MCP server. Your job is to traverse the Canvas API hierarchy to find exactly what the user is looking for, and return ONLY the final relevant results.

Canvas has a strict hierarchy: Courses → Modules → Module Items (files, pages, assignments) → File URLs

Guidelines:
- Start by getting courses to find the relevant course ID
- Use fuzzy name matching - course names often include section numbers, semesters, etc.
- When looking for resources, traverse: get_courses → get_modules → get_module_items
- When looking for assignments, use get_course_assignments directly after finding the course
- For files, also get the file URL using get_file_url
- If the user mentions a specific course name, only search that course
- If no course is specified, search across all courses but be VERY efficient - max 3 courses
- Return a clean, concise summary of what you found - not raw JSON dumps
- If you can't find something, say so clearly and suggest what's available
- Be efficient: don't fetch data you don't need
- CRITICAL: You are running on Cloudflare Workers with a 50 subrequest limit. Limit get_module_items calls to max 3-4 modules. For overviews, list modules but only fetch items for the most relevant 2-3.
- When getting module items, do NOT also call get_file_url - the items already include html_url
- IMPORTANT: Always end with a final text summary, never end on a tool call`;

export class CanvasAgent {
  private config: AgentConfig;
  private maxTurns = 12;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Execute an internal tool call against the Canvas API
   */
  private async executeTool(name: string, args: any): Promise<string> {
    const { canvasApi } = this.config;

    try {
      switch (name) {
        case "get_courses": {
          const courses = await canvasApi.getCourses();
          return courses ? JSON.stringify(courses) : "No courses found";
        }
        case "get_modules": {
          const modules = await canvasApi.getModules(args.course_id);
          // Return condensed version to save tokens
          if (modules) {
            const condensed = modules.map(m => ({ id: m.id, name: m.name, items_count: m.items_count }));
            return JSON.stringify(condensed);
          }
          return "No modules found";
        }
        case "get_module_items": {
          // Skip file enrichment to avoid Cloudflare subrequest limits
          const items = await canvasApi.getModuleItems(args.course_id, args.module_id, { skipFileEnrichment: true });
          if (items) {
            // Return condensed version to save tokens
            const condensed = items.map(item => ({
              id: item.id,
              title: item.title,
              type: item.type,
              content_id: item.content_id,
              html_url: item.html_url,
            }));
            return JSON.stringify(condensed);
          }
          return "No items found";
        }
        case "get_file_url": {
          const url = await canvasApi.getFileUrl(args.course_id, args.file_id);
          return url || "File URL not found";
        }
        case "get_course_assignments": {
          const assignments = await canvasApi.getCourseAssignments(args.course_id, args.bucket);
          return assignments ? JSON.stringify(assignments) : "No assignments found";
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error: any) {
      return `Error executing ${name}: ${error.message}`;
    }
  }

  /**
   * Run the agent loop: send query to LLM, handle tool calls, return final answer
   */
  async run(userQuery: string): Promise<{ result: string; toolCallCount: number; turns: number }> {
    const messages: any[] = [
      { role: "user", content: userQuery },
    ];

    let toolCallCount = 0;
    let turns = 0;

    for (let i = 0; i < this.maxTurns; i++) {
      turns++;
      this.config.logger.debug(`Agent turn ${turns}, messages: ${messages.length}`);

      // Call LLM via OpenRouter
      const response = await this.callLLM(messages);

      if (!response) {
        return { result: "Agent error: failed to get response from AI", toolCallCount, turns };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        return { result: "Agent error: no response choice", toolCallCount, turns };
      }

      const message = choice.message;

      // Add assistant message to history
      messages.push(message);

      // Check if there are tool calls
      if (!message.tool_calls || message.tool_calls.length === 0) {
        // No tool calls - agent is done
        return { result: message.content || "No result", toolCallCount, turns };
      }

      // Execute all tool calls
      for (const toolCall of message.tool_calls) {
        toolCallCount++;
        const fnName = toolCall.function.name;
        let fnArgs: any;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }

        this.config.logger.debug(`Agent calling tool: ${fnName}(${JSON.stringify(fnArgs)})`);

        const result = await this.executeTool(fnName, fnArgs);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    return { result: "Agent reached maximum turns without completing", toolCallCount, turns };
  }

  /**
   * Call LLM via OpenRouter (Kimi K2)
   */
  private async callLLM(messages: any[]): Promise<any> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.openRouterApiKey}`,
          "HTTP-Referer": "https://github.com/aryankeluskar/canvas-mcp",
          "X-Title": "Canvas MCP Agent",
        },
        body: JSON.stringify({
          model: "moonshotai/kimi-k2-0905",
          max_tokens: 4096,
          messages: [
            { role: "system", content: AGENT_SYSTEM_PROMPT },
            ...messages,
          ],
          tools: CANVAS_AGENT_TOOLS,
          tool_choice: "auto",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.config.logger.error(`OpenRouter API error: ${response.status} ${errorText}`);
        return null;
      }

      return await response.json();
    } catch (error: any) {
      this.config.logger.error(`OpenRouter API call failed: ${error.message}`);
      return null;
    }
  }
}
