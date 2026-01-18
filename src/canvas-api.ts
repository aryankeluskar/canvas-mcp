/**
 * Canvas LMS API integration
 * Compatible with Cloudflare Workers runtime (uses native fetch)
 */

import { WorkerCache } from "./cache.js";
import { Logger } from "./config.js";

interface CanvasApiConfig {
  apiKey: string;
  baseUrl: string;
  logger: Logger;
  cache: WorkerCache;
}

interface Course {
  id: number;
  name: string;
  course_code?: string;
  workflow_state?: string;
}

interface Module {
  id: number;
  name: string;
  position?: number;
  unlock_at?: string;
  require_sequential_progress?: boolean;
  publish_final_grade?: boolean;
  prerequisite_module_ids?: number[];
  state?: string;
  completed_at?: string;
  items_count?: number;
  items_url?: string;
}

interface ModuleItem {
  id: number;
  title: string;
  position?: number;
  indent?: number;
  type?: string;
  module_id?: number;
  html_url?: string;
  content_id?: number;
  page_url?: string;
  external_url?: string;
  new_tab?: boolean;
  completion_requirement?: any;
  published?: boolean;
  // Enhanced fields for file content
  file_url?: string;
  file_meta?: {
    display_name?: string;
    filename?: string;
    size?: number;
    content_type?: string;
  };
  file_content_text?: string;
  file_content_base64?: string;
  file_content_type?: string;
  file_content_size?: number;
  file_content_truncated?: boolean;
  is_public_link?: boolean;
}

interface Assignment {
  id: number;
  name: string;
  description?: string;
  due_at?: string;
  has_submitted_submissions?: boolean;
  points_possible?: number;
  submission_types?: string[];
  workflow_state?: string;
}

interface FileData {
  id: number;
  display_name?: string;
  filename?: string;
  size?: number;
  "content-type"?: string;
  content_type?: string;
  url?: string;
  download_url?: string;
}

const MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MB cap to avoid huge downloads

export class CanvasApi {
  private config: CanvasApiConfig;

  constructor(config: CanvasApiConfig) {
    this.config = config;
  }

  /**
   * Make a GET request to Canvas API with authentication
   */
  private async makeRequest<T>(
    endpoint: string,
    params?: Record<string, string>
  ): Promise<T | null> {
    try {
      const url = new URL(endpoint, this.config.baseUrl);
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }

      this.config.logger.debug(`Making Canvas API request to: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
          "User-Agent": "Canvas-MCP/1.1.0",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.config.logger.error(
          `Canvas API error: ${response.status} ${response.statusText}`
        );
        const errorText = await response.text();
        this.config.logger.error(`Response: ${errorText}`);
        return null;
      }

      return (await response.json()) as T;
    } catch (error) {
      this.config.logger.error(`Canvas API request failed:`, error);
      return null;
    }
  }

  /**
   * Get all available Canvas courses for the current user
   */
  async getCourses(): Promise<Record<string, number> | null> {
    // Check cache first
    const cached = this.config.cache.get<Record<string, number>>("courses");
    if (cached) {
      this.config.logger.debug("Using cached courses data");
      return cached;
    }

    try {
      const courses = await this.makeRequest<Course[]>("/api/v1/courses", {
        page: "1",
        per_page: "100",
      });

      if (!courses) {
        this.config.logger.error("Failed to fetch courses from Canvas API");
        return null;
      }

      const coursesMap: Record<string, number> = {};
      courses.forEach((course) => {
        if (course.id && course.name) {
          coursesMap[course.name] = course.id;
        }
      });

      if (Object.keys(coursesMap).length === 0) {
        this.config.logger.warn("No courses found in Canvas API response");
        return null;
      }

      // Store in cache
      this.config.cache.set("courses", coursesMap);
      this.config.logger.debug(
        `Cached ${Object.keys(coursesMap).length} courses`
      );

      return coursesMap;
    } catch (error) {
      this.config.logger.error("Unexpected error in getCourses:", error);
      return null;
    }
  }

  /**
   * Get all modules within a specific Canvas course
   */
  async getModules(courseId: string | number): Promise<Module[] | null> {
    const courseIdStr = String(courseId);

    // Check cache first
    const cached = this.config.cache.get<Module[]>("modules", courseIdStr);
    if (cached) {
      this.config.logger.debug(
        `Using cached modules data for course ${courseId}`
      );
      return cached;
    }

    try {
      const modules = await this.makeRequest<Module[]>(
        `/api/v1/courses/${courseId}/modules`
      );

      if (!modules) {
        this.config.logger.error(`Failed to fetch modules for course ${courseId}`);
        return null;
      }

      if (modules.length === 0) {
        this.config.logger.warn(`No modules found for course ${courseId}`);
        return null;
      }

      // Store in cache
      this.config.cache.set("modules", modules, courseIdStr);
      this.config.logger.debug(
        `Cached ${modules.length} modules for course ${courseId}`
      );

      return modules;
    } catch (error) {
      this.config.logger.error("Unexpected error in getModules:", error);
      return null;
    }
  }

  /**
   * Get all items within a specific module, with file content enrichment
   */
  async getModuleItems(
    courseId: string | number,
    moduleId: string | number
  ): Promise<ModuleItem[] | null> {
    const cacheKey = `${courseId}_${moduleId}`;

    // Check cache first
    const cached = this.config.cache.get<ModuleItem[]>("module_items", cacheKey);
    if (cached) {
      this.config.logger.debug(
        `Using cached module items for module ${moduleId} in course ${courseId}`
      );
      return cached;
    }

    try {
      const items = await this.makeRequest<ModuleItem[]>(
        `/api/v1/courses/${courseId}/modules/${moduleId}/items`,
        { per_page: "100" }
      );

      if (!items) {
        this.config.logger.error(
          `Failed to fetch module items for module ${moduleId} in course ${courseId}`
        );
        return null;
      }

      if (items.length === 0) {
        this.config.logger.warn(
          `No items found for module ${moduleId} in course ${courseId}`
        );
        return null;
      }

      // Enrich File-type items with direct file URLs and content
      await this.enrichFileItems(items, String(courseId));

      // Store in cache
      this.config.cache.set("module_items", items, cacheKey);
      this.config.logger.debug(
        `Cached ${items.length} module items for module ${moduleId}`
      );

      return items;
    } catch (error) {
      this.config.logger.error("Unexpected error in getModuleItems:", error);
      return null;
    }
  }

  /**
   * Enrich file-type module items with download URLs and content
   */
  private async enrichFileItems(
    items: ModuleItem[],
    courseId: string
  ): Promise<void> {
    for (const item of items) {
      if (item.type === "File" && item.content_id) {
        try {
          const fileId = item.content_id;

          // Get file URL (with cache)
          const fileCacheKey = `${courseId}_${fileId}`;
          let fileUrl = this.config.cache.get<string>("file_urls", fileCacheKey);

          if (!fileUrl) {
            const fileData = await this.makeRequest<FileData>(
              `/api/v1/courses/${courseId}/files/${fileId}`
            );
            if (fileData) {
              fileUrl = fileData.url || fileData.download_url || null;

              // Attach minimal metadata
              item.file_meta = {
                display_name: fileData.display_name,
                filename: fileData.filename,
                size: fileData.size,
                content_type: fileData["content-type"] || fileData.content_type,
              };

              if (fileUrl) {
                this.config.cache.set("file_urls", fileUrl, fileCacheKey);
              }
            }
          }

          if (fileUrl) {
            item.file_url = fileUrl;

            // Try to download file content
            await this.downloadFileContent(item, fileUrl);
          }
        } catch (error) {
          this.config.logger.warn(
            `Failed to enrich file item ${item.id}:`,
            error
          );
        }
      }
    }
  }

  /**
   * Download and process file content for module items
   * For PDFs, provides public links instead of downloading content
   */
  private async downloadFileContent(
    item: ModuleItem,
    fileUrl: string
  ): Promise<void> {
    try {
      // First try HEAD request to check content type and size
      const headController = new AbortController();
      const headTimeoutId = setTimeout(() => headController.abort(), 10000);

      const headResponse = await fetch(fileUrl, {
        method: "HEAD",
        signal: headController.signal,
      });

      clearTimeout(headTimeoutId);

      let contentType = "";
      if (headResponse.ok) {
        contentType = headResponse.headers.get("content-type") || "";

        // For PDFs, just provide the public URL instead of downloading content
        if (
          contentType === "application/pdf" ||
          fileUrl.toLowerCase().endsWith(".pdf")
        ) {
          item.file_content_type = contentType || "application/pdf";
          item.file_url = fileUrl;
          item.file_content_truncated = false;
          item.is_public_link = true;
          this.config.logger.debug(`Providing public link for PDF: ${fileUrl}`);
          return;
        }

        const contentLength = headResponse.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_CONTENT_BYTES) {
          item.file_content_truncated = true;
          return;
        }
      }

      // GET the content for non-PDF files
      const downloadController = new AbortController();
      const downloadTimeoutId = setTimeout(
        () => downloadController.abort(),
        20000
      );

      const response = await fetch(fileUrl, {
        signal: downloadController.signal,
      });

      clearTimeout(downloadTimeoutId);
      if (!response.ok) {
        this.config.logger.warn(
          `Could not download file content, status ${response.status}`
        );
        return;
      }

      const buffer = await response.arrayBuffer();
      contentType = response.headers.get("content-type") || contentType;

      item.file_content_type = contentType;
      item.file_content_size = buffer.byteLength;

      if (buffer.byteLength > MAX_CONTENT_BYTES) {
        item.file_content_truncated = true;
        // Keep first MAX_CONTENT_BYTES bytes
        const truncatedBuffer = buffer.slice(0, MAX_CONTENT_BYTES);
        item.file_content_base64 = arrayBufferToBase64(truncatedBuffer);
      } else {
        item.file_content_truncated = false;
        item.file_content_base64 = arrayBufferToBase64(buffer);
      }

      // If text-like, also provide decoded text
      if (
        contentType.startsWith("text/") ||
        contentType.includes("application/json") ||
        contentType.includes("application/xml")
      ) {
        try {
          const decoder = new TextDecoder("utf-8");
          const text = decoder.decode(buffer);
          item.file_content_text = text;
        } catch (error) {
          this.config.logger.warn("Failed to decode file as text:", error);
        }
      }
    } catch (error) {
      this.config.logger.warn("Failed to download file content:", error);
    }
  }

  /**
   * Get direct download URL for a file stored in Canvas
   */
  async getFileUrl(
    courseId: string | number,
    fileId: string | number
  ): Promise<string | null> {
    const cacheKey = `${courseId}_${fileId}`;

    // Check cache first
    const cached = this.config.cache.get<string>("file_urls", cacheKey);
    if (cached) {
      this.config.logger.debug(
        `Using cached file URL for file ${fileId} in course ${courseId}`
      );
      return cached;
    }

    try {
      const fileData = await this.makeRequest<FileData>(
        `/api/v1/courses/${courseId}/files/${fileId}`
      );

      if (!fileData) {
        this.config.logger.error(`Failed to fetch file URL for file ${fileId}`);
        return null;
      }

      const fileUrl = fileData.url;
      if (!fileUrl) {
        this.config.logger.warn(`No URL found in file data for file ${fileId}`);
        return null;
      }

      // Store in cache
      this.config.cache.set("file_urls", fileUrl, cacheKey);
      return fileUrl;
    } catch (error) {
      this.config.logger.error("Unexpected error in getFileUrl:", error);
      return null;
    }
  }

  /**
   * Get all assignments for a specific Canvas course
   */
  async getCourseAssignments(
    courseId: string | number,
    bucket?: string
  ): Promise<Assignment[] | null> {
    try {
      const params: Record<string, string> = {
        order_by: "due_at",
        per_page: "100",
        "include[]": JSON.stringify(["submission", "all_dates"]),
      };

      if (bucket) {
        params.bucket = bucket;
      }

      const assignments = await this.makeRequest<Assignment[]>(
        `/api/v1/courses/${courseId}/assignments`,
        params
      );

      if (!assignments) {
        this.config.logger.error(
          `Failed to fetch assignments for course ${courseId}`
        );
        return null;
      }

      // Return simplified assignment data
      return assignments.map((assignment) => ({
        id: assignment.id,
        name: assignment.name,
        description: assignment.description,
        due_at: assignment.due_at,
        has_submitted_submissions: assignment.has_submitted_submissions,
      }));
    } catch (error) {
      this.config.logger.error(
        "Unexpected error in getCourseAssignments:",
        error
      );
      return null;
    }
  }

  /**
   * Get assignments for a Canvas course using its name rather than ID
   */
  async getAssignmentsByCourseName(
    courseName: string,
    bucket?: string
  ): Promise<Assignment[] | null> {
    try {
      // First get all courses to find the course ID
      const courses = await this.getCourses();
      if (!courses) {
        this.config.logger.error("Could not fetch courses");
        return null;
      }

      // Find the course ID by name (partial match)
      let courseId: number | null = null;
      for (const [name, id] of Object.entries(courses)) {
        if (name.toLowerCase().includes(courseName.toLowerCase())) {
          courseId = id;
          break;
        }
      }

      if (!courseId) {
        this.config.logger.error(`Course '${courseName}' not found`);
        this.config.logger.debug("Available courses:", Object.keys(courses));
        return null;
      }

      // Get assignments using the course ID
      return await this.getCourseAssignments(courseId, bucket);
    } catch (error) {
      this.config.logger.error(
        "Unexpected error in getAssignmentsByCourseName:",
        error
      );
      return null;
    }
  }
}

/**
 * Convert ArrayBuffer to base64 string (Workers-compatible)
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export type { Course, Module, ModuleItem, Assignment, FileData, CanvasApiConfig };
