/**
 * Gradescope API integration
 * Compatible with Cloudflare Workers runtime (uses native fetch)
 * Handles real authentication, HTML parsing, and data extraction
 */

import * as cheerio from "cheerio";
import { WorkerCache } from "./cache.js";
import { Logger } from "./config.js";

interface GradescopeConfig {
  email: string;
  password: string;
  logger: Logger;
  cache: WorkerCache;
}

interface GradescopeCourse {
  id: string;
  name: string;
  full_name: string;
  semester: string;
  year: string;
  num_grades_published: string | null;
  num_assignments: string;
}

interface GradescopeAssignment {
  assignment_id: string;
  name: string;
  release_date: Date | null;
  due_date: Date | null;
  late_due_date: Date | null;
  submissions_status: string | null;
  grade: number | null;
  max_grade: number | null;
}

interface GradescopeMember {
  full_name: string;
  first_name: string;
  last_name: string;
  sid: string;
  email: string;
  role: string;
  user_id: string | null;
  num_submissions: number;
  sections: string;
  course_id: string;
}

interface GradescopeQueryAnalysis {
  type: "get_courses" | "get_assignments" | "get_submission" | null;
  course_id?: string;
  course_name?: string;
  assignment_id?: string;
  assignment_name?: string;
  student_email?: string;
  confidence: number;
}

const DEFAULT_GRADESCOPE_BASE_URL = "https://www.gradescope.com";

/**
 * Simple cookie manager for Workers runtime
 */
class CookieManager {
  private cookies: Map<string, string> = new Map();

  /**
   * Parse and store cookies from Set-Cookie header
   */
  setCookiesFromHeaders(headers: Headers): void {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    for (const cookie of setCookieHeaders) {
      const parts = cookie.split(";")[0].split("=");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join("=").trim();
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Get cookie string for request header
   */
  getCookieString(): string {
    const entries: string[] = [];
    for (const [name, value] of this.cookies.entries()) {
      entries.push(`${name}=${value}`);
    }
    return entries.join("; ");
  }

  /**
   * Clear all cookies
   */
  clear(): void {
    this.cookies.clear();
  }
}

export class GradescopeApi {
  private config: GradescopeConfig;
  private cookieManager: CookieManager;
  private isAuthenticated: boolean = false;
  private csrfToken: string = "";

  constructor(config: GradescopeConfig) {
    this.config = config;
    this.cookieManager = new CookieManager();
  }

  /**
   * Authenticate with Gradescope using real login flow
   */
  private async authenticate(): Promise<boolean> {
    if (this.isAuthenticated) {
      return true;
    }

    try {
      this.config.logger.debug("Starting Gradescope authentication...");

      // Step 1: Get homepage to extract authenticity token and set initial session cookie
      const authToken = await this.getAuthTokenAndInitSession();
      if (!authToken) {
        this.config.logger.error("Failed to get authentication token");
        return false;
      }

      // Step 2: Login with credentials and auth token
      const loginSuccess = await this.loginWithCredentials(authToken);
      if (!loginSuccess) {
        this.config.logger.error("Login failed");
        return false;
      }

      this.isAuthenticated = true;
      this.config.logger.debug("Gradescope authentication successful");
      return true;
    } catch (error) {
      this.config.logger.error("Gradescope authentication failed:", error);
      return false;
    }
  }

  /**
   * Get authenticity token from homepage and initialize session
   */
  private async getAuthTokenAndInitSession(): Promise<string | null> {
    try {
      const response = await fetch(DEFAULT_GRADESCOPE_BASE_URL, {
        method: "GET",
        headers: {
          "User-Agent": "Canvas-MCP/1.1.0",
        },
      });

      if (!response.ok) {
        this.config.logger.error(`Failed to load homepage: ${response.status}`);
        return null;
      }

      // Store cookies from homepage
      this.cookieManager.setCookiesFromHeaders(response.headers);

      const html = await response.text();
      const $ = cheerio.load(html);

      // Find the authenticity token
      const authTokenElement = $(
        'form[action="/login"] input[name="authenticity_token"]'
      );
      const authToken = authTokenElement.attr("value");

      if (!authToken) {
        this.config.logger.error(
          "Could not find authenticity token on homepage"
        );
        return null;
      }

      return authToken;
    } catch (error) {
      this.config.logger.error("Error getting auth token:", error);
      return null;
    }
  }

  /**
   * Login with credentials and auth token
   */
  private async loginWithCredentials(authToken: string): Promise<boolean> {
    try {
      const loginEndpoint = `${DEFAULT_GRADESCOPE_BASE_URL}/login`;

      // Get cookies for the login request
      const cookieHeader = this.cookieManager.getCookieString();

      const loginData = new URLSearchParams({
        utf8: "✓",
        "session[email]": this.config.email,
        "session[password]": this.config.password,
        "session[remember_me]": "0",
        commit: "Log In",
        "session[remember_me_sso]": "0",
        authenticity_token: authToken,
      });

      const response = await fetch(loginEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Canvas-MCP/1.1.0",
          Cookie: cookieHeader,
          Referer: DEFAULT_GRADESCOPE_BASE_URL,
        },
        body: loginData,
        redirect: "manual", // Handle redirects manually to detect success
      });

      // Store new cookies from login response
      this.cookieManager.setCookiesFromHeaders(response.headers);

      // Success is marked by a 302 redirect
      if (response.status === 302) {
        this.config.logger.debug("Login redirect detected - success");

        // Follow the redirect to get the CSRF token from the account page
        const redirectLocation = response.headers.get("location");
        if (redirectLocation) {
          await this.extractCSRFToken(redirectLocation);
        }

        return true;
      } else {
        this.config.logger.error(`Login failed with status: ${response.status}`);
        return false;
      }
    } catch (error) {
      this.config.logger.error("Error during login:", error);
      return false;
    }
  }

  /**
   * Extract CSRF token from account page after successful login
   */
  private async extractCSRFToken(redirectUrl: string): Promise<void> {
    try {
      const fullUrl = redirectUrl.startsWith("http")
        ? redirectUrl
        : `${DEFAULT_GRADESCOPE_BASE_URL}${redirectUrl}`;
      const cookieHeader = this.cookieManager.getCookieString();

      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Canvas-MCP/1.1.0",
          Cookie: cookieHeader,
        },
      });

      if (response.ok) {
        // Store any new cookies
        this.cookieManager.setCookiesFromHeaders(response.headers);

        const html = await response.text();
        const $ = cheerio.load(html);
        const csrfTokenElement = $('meta[name="csrf-token"]');
        const csrfToken = csrfTokenElement.attr("content");

        if (csrfToken) {
          this.csrfToken = csrfToken;
          this.config.logger.debug("CSRF token extracted successfully");
        }
      }
    } catch (error) {
      this.config.logger.error("Error extracting CSRF token:", error);
    }
  }

  /**
   * Make authenticated request to Gradescope
   */
  private async makeAuthenticatedRequest(
    url: string,
    options: RequestInit = {}
  ): Promise<Response | null> {
    if (!(await this.authenticate())) {
      return null;
    }

    try {
      const cookieHeader = this.cookieManager.getCookieString();
      const headers: Record<string, string> = {
        "User-Agent": "Canvas-MCP/1.1.0",
        Cookie: cookieHeader,
        ...(options.headers as Record<string, string>),
      };

      if (this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }

      const response = await fetch(url, {
        ...options,
        headers,
      });

      // Store any new cookies
      this.cookieManager.setCookiesFromHeaders(response.headers);

      if (response.status === 401) {
        this.config.logger.error(
          "Unauthorized - authentication may have expired"
        );
        this.isAuthenticated = false;
        return null;
      }

      if (!response.ok) {
        this.config.logger.error(
          `Request failed: ${response.status} ${response.statusText}`
        );
        return null;
      }

      return response;
    } catch (error) {
      this.config.logger.error("Error making authenticated request:", error);
      return null;
    }
  }

  /**
   * Get all courses from Gradescope
   */
  async getGradescopeCourses(): Promise<Record<
    string,
    Record<string, GradescopeCourse>
  > | null> {
    // Check cache first
    const cached = this.config.cache.get<
      Record<string, Record<string, GradescopeCourse>>
    >("gradescope_courses");
    if (cached) {
      this.config.logger.debug("Using cached Gradescope courses data");
      return cached;
    }

    try {
      const accountUrl = `${DEFAULT_GRADESCOPE_BASE_URL}/account`;
      const response = await this.makeAuthenticatedRequest(accountUrl);
      if (!response) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const courses: {
        instructor: Record<string, GradescopeCourse>;
        student: Record<string, GradescopeCourse>;
      } = { instructor: {}, student: {} };

      // Parse instructor courses if present
      const instructorCourses = await this.parseCoursesFromHTML(
        $,
        "Instructor Courses"
      );
      if (instructorCourses) {
        courses.instructor = instructorCourses.courses;
      }

      // Parse student courses if present
      const studentCourses = await this.parseCoursesFromHTML(
        $,
        "Student Courses"
      );
      if (studentCourses) {
        courses.student = studentCourses.courses;
      }

      // If no specific instructor/student sections, check for generic "Your Courses"
      if (
        Object.keys(courses.instructor).length === 0 &&
        Object.keys(courses.student).length === 0
      ) {
        const yourCourses = await this.parseCoursesFromHTML($, "Your Courses");
        if (yourCourses) {
          if (yourCourses.isInstructor) {
            courses.instructor = yourCourses.courses;
          } else {
            courses.student = yourCourses.courses;
          }
        }
      }

      // Format for serialization
      const serializedCourses: Record<
        string,
        Record<string, GradescopeCourse>
      > = {
        student: Object.fromEntries(
          Object.entries(courses.student).map(([id, course]) => [
            `Course ID: ${id}`,
            course,
          ])
        ) as Record<string, GradescopeCourse>,
        instructor: Object.fromEntries(
          Object.entries(courses.instructor).map(([id, course]) => [
            `Course ID: ${id}`,
            course,
          ])
        ) as Record<string, GradescopeCourse>,
      };

      // Store in cache
      this.config.cache.set("gradescope_courses", serializedCourses);
      this.config.logger.debug(
        `Retrieved ${Object.keys(courses.student).length} student courses and ${Object.keys(courses.instructor).length} instructor courses`
      );

      return serializedCourses;
    } catch (error) {
      this.config.logger.error("Error in getGradescopeCourses:", error);
      return null;
    }
  }

  /**
   * Parse courses from HTML
   */
  private async parseCoursesFromHTML(
    $: cheerio.CheerioAPI,
    userType: string
  ): Promise<{
    courses: Record<string, GradescopeCourse>;
    isInstructor: boolean;
  } | null> {
    const courses: Record<string, GradescopeCourse> = {};

    // Find heading for user type courses
    const coursesHeading = $(`h1.pageHeading:contains("${userType}")`).first();
    if (coursesHeading.length === 0) {
      return null;
    }

    // Check if user is instructor by looking for "Create a new course" button
    const button = coursesHeading.next("button");
    const isInstructor = button.text().trim().includes("Create a new course");

    // Find the course list
    const courseList = coursesHeading.nextAll(".courseList").first();
    if (courseList.length === 0) {
      return { courses, isInstructor };
    }

    // Parse each term section
    courseList.find(".courseList--term").each((_, termElement) => {
      const termEl = $(termElement);

      // Extract semester and year from term text
      const termText = termEl.contents().first().text().trim();
      const [semester, year] = termText.split(" ");

      // Parse each course in this term
      termEl.find("a").each((_, courseElement) => {
        const courseEl = $(courseElement);
        const href = courseEl.attr("href");

        if (!href) return;

        const courseId = href.split("/").pop();
        if (!courseId) return;

        // Extract course details
        const shortName = courseEl.find("h3.courseBox--shortname").text().trim();
        const fullName = courseEl.find(".courseBox--name").text().trim();

        let numGradesPublished: string | null = null;
        let numAssignments = "";

        if (userType === "Instructor Courses" || isInstructor) {
          const gradesEl = courseEl.find(".courseBox--noGradesPublised");
          if (gradesEl.length > 0) {
            numGradesPublished = gradesEl.text().trim();
          }

          const assignmentsEl = courseEl.find(
            ".courseBox--assignments.courseBox--assignments-unpublished"
          );
          if (assignmentsEl.length > 0) {
            numAssignments = assignmentsEl.text().trim();
          }
        } else {
          const assignmentsEl = courseEl.find(".courseBox--assignments");
          if (assignmentsEl.length > 0) {
            numAssignments = assignmentsEl.text().trim();
          }
        }

        courses[courseId] = {
          id: courseId,
          name: shortName,
          full_name: fullName,
          semester: semester || "",
          year: year || "",
          num_grades_published: numGradesPublished,
          num_assignments: numAssignments,
        };
      });
    });

    return { courses, isInstructor };
  }

  /**
   * Get a course from Gradescope by name
   */
  async getGradescopeCourseByName(
    courseName: string
  ): Promise<GradescopeCourse | null> {
    const courses = await this.getGradescopeCourses();
    if (!courses) {
      return null;
    }

    for (const course of Object.values(courses.student)) {
      if (
        course.name.toLowerCase().includes(courseName.toLowerCase()) ||
        course.full_name.toLowerCase().includes(courseName.toLowerCase())
      ) {
        return course;
      }
    }

    for (const course of Object.values(courses.instructor)) {
      if (
        course.name.toLowerCase().includes(courseName.toLowerCase()) ||
        course.full_name.toLowerCase().includes(courseName.toLowerCase())
      ) {
        return course;
      }
    }

    return null;
  }

  /**
   * Get all assignments for a course
   */
  async getGradescopeAssignments(
    courseId: string
  ): Promise<GradescopeAssignment[] | null> {
    // Check cache first
    const cached = this.config.cache.get<GradescopeAssignment[]>(
      "gradescope_assignments",
      courseId
    );
    if (cached) {
      this.config.logger.debug(
        `Using cached Gradescope assignments for course ${courseId}`
      );
      return cached;
    }

    try {
      const courseUrl = `${DEFAULT_GRADESCOPE_BASE_URL}/courses/${courseId}`;
      const response = await this.makeAuthenticatedRequest(courseUrl);
      if (!response) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Try instructor view first (has React props with assignment data)
      let assignments = this.parseAssignmentsInstructorView($);

      // If no assignments found, try student view
      if (!assignments || assignments.length === 0) {
        assignments = this.parseAssignmentsStudentView($);
      }

      if (assignments) {
        // Store in cache
        this.config.cache.set("gradescope_assignments", assignments, courseId);
        this.config.logger.debug(
          `Retrieved ${assignments.length} assignments for course ${courseId}`
        );
      }

      return assignments;
    } catch (error) {
      this.config.logger.error("Error in getGradescopeAssignments:", error);
      return null;
    }
  }

  /**
   * Parse assignments from instructor view
   */
  private parseAssignmentsInstructorView(
    $: cheerio.CheerioAPI
  ): GradescopeAssignment[] | null {
    const assignmentsList: GradescopeAssignment[] = [];

    const elementWithProps = $('div[data-react-class="AssignmentsTable"]');
    if (elementWithProps.length === 0) {
      return null;
    }

    const propsStr = elementWithProps.attr("data-react-props");
    if (!propsStr) {
      return null;
    }

    try {
      const assignmentJson = JSON.parse(propsStr);

      for (const assignment of assignmentJson.table_data || []) {
        // Skip non-assignment data like sections
        if (assignment.type !== "assignment") {
          continue;
        }

        const assignmentObj: GradescopeAssignment = {
          assignment_id: assignment.url?.split("/").pop() || "",
          name: assignment.title || "",
          release_date: assignment.submission_window?.release_date
            ? new Date(assignment.submission_window.release_date)
            : null,
          due_date: assignment.submission_window?.due_date
            ? new Date(assignment.submission_window.due_date)
            : null,
          late_due_date: assignment.submission_window?.hard_due_date
            ? new Date(assignment.submission_window.hard_due_date)
            : null,
          submissions_status: null,
          grade: null,
          max_grade: assignment.total_points
            ? parseFloat(assignment.total_points)
            : null,
        };

        assignmentsList.push(assignmentObj);
      }

      return assignmentsList;
    } catch (error) {
      this.config.logger.error(
        "Error parsing instructor view assignments:",
        error
      );
      return null;
    }
  }

  /**
   * Parse assignments from student view
   */
  private parseAssignmentsStudentView(
    $: cheerio.CheerioAPI
  ): GradescopeAssignment[] | null {
    const assignmentsList: GradescopeAssignment[] = [];

    // Find assignment rows (skip header and tail)
    const assignmentRows = $('tr[role="row"]').slice(1, -1);

    assignmentRows.each((_, row) => {
      const rowEl = $(row);
      const cells = rowEl.find("th, td");

      if (cells.length < 3) return;

      // Extract assignment name and ID
      const nameCell = $(cells[0]);
      const name = nameCell.text().trim();

      let assignmentId: string | null = null;
      const assignmentLink = nameCell.find("a[href]");
      const assignmentButton = nameCell.find("button.js-submitAssignment");

      if (assignmentLink.length > 0) {
        const href = assignmentLink.attr("href");
        if (href) {
          assignmentId = href.split("/")[4]; // Extract from URL structure
        }
      } else if (assignmentButton.length > 0) {
        assignmentId = assignmentButton.attr("data-assignment-id") || null;
      }

      // Extract points/grade information
      let grade: number | null = null;
      let maxGrade: number | null = null;
      let submissionStatus = "Not Submitted";

      const pointsText = $(cells[1]).text().trim();
      if (pointsText.includes(" / ")) {
        const points = pointsText.split(" / ");
        try {
          grade = parseFloat(points[0]);
          maxGrade = parseFloat(points[1]);
          submissionStatus = "Submitted";
        } catch {
          // Keep defaults
        }
      } else {
        submissionStatus = pointsText;
      }

      // Extract dates from submission time chart
      let releaseDate: Date | null = null;
      let dueDate: Date | null = null;
      let lateDueDate: Date | null = null;

      const dateCell = $(cells[2]);
      const releaseDateEl = dateCell.find(".submissionTimeChart--releaseDate");
      const dueDateEls = dateCell.find(".submissionTimeChart--dueDate");

      if (releaseDateEl.length > 0) {
        const datetime = releaseDateEl.attr("datetime");
        if (datetime) {
          releaseDate = new Date(datetime);
        }
      }

      if (dueDateEls.length > 0) {
        const firstDueDatetime = $(dueDateEls[0]).attr("datetime");
        if (firstDueDatetime) {
          dueDate = new Date(firstDueDatetime);
        }

        if (dueDateEls.length > 1) {
          const lateDueDatetime = $(dueDateEls[1]).attr("datetime");
          if (lateDueDatetime) {
            lateDueDate = new Date(lateDueDatetime);
          }
        }
      }

      const assignmentObj: GradescopeAssignment = {
        assignment_id: assignmentId || "",
        name,
        release_date: releaseDate,
        due_date: dueDate,
        late_due_date: lateDueDate,
        submissions_status: submissionStatus,
        grade,
        max_grade: maxGrade,
      };

      assignmentsList.push(assignmentObj);
    });

    return assignmentsList;
  }

  /**
   * Get an assignment by name within a course
   */
  async getGradescopeAssignmentByName(
    courseId: string,
    assignmentName: string
  ): Promise<GradescopeAssignment | null> {
    const assignments = await this.getGradescopeAssignments(courseId);
    if (!assignments) {
      return null;
    }

    for (const assignment of assignments) {
      if (assignment.name.toLowerCase().includes(assignmentName.toLowerCase())) {
        return assignment;
      }
    }
    return null;
  }

  /**
   * Analyze a natural language query to determine what Gradescope information is being requested
   */
  analyzeGradescopeQuery(query: string): GradescopeQueryAnalysis {
    const result: GradescopeQueryAnalysis = {
      type: null,
      confidence: 0.0,
    };

    const queryLower = query.toLowerCase();

    // Check for courses request
    if (
      ["my courses", "list courses", "show courses", "what courses"].some(
        (keyword) => queryLower.includes(keyword)
      )
    ) {
      result.type = "get_courses";
      result.confidence = 0.9;
      return result;
    }

    // Check for assignments request
    if (
      ["assignments", "homework", "due dates"].some((keyword) =>
        queryLower.includes(keyword)
      )
    ) {
      result.type = "get_assignments";
      result.confidence = 0.8;
      return result;
    }

    // Check for submission request
    if (
      ["submission", "submitted", "grade", "feedback", "score"].some((keyword) =>
        queryLower.includes(keyword)
      )
    ) {
      result.type = "get_submission";
      result.confidence = 0.7;
      return result;
    }

    return result;
  }

  /**
   * Search for information across Gradescope using natural language queries
   */
  async searchGradescope(query: string): Promise<any> {
    const analysis = this.analyzeGradescopeQuery(query);

    switch (analysis.type) {
      case "get_courses":
        const courses = await this.getGradescopeCourses();
        if (!courses) {
          return { error: "Could not retrieve Gradescope courses" };
        }
        return courses;

      case "get_assignments":
      case "get_submission":
        // Both assignments and submission queries return assignment data
        const allCourses = await this.getGradescopeCourses();
        if (allCourses) {
          return {
            message:
              "Please specify which course you're interested in. Here are your courses:",
            courses: allCourses,
          };
        } else {
          return {
            error: "Could not determine which course to get assignments for",
          };
        }

      default:
        return {
          error:
            "I'm not sure what you're asking about Gradescope. Try asking about your courses or assignments.",
        };
    }
  }
}

export type {
  GradescopeConfig,
  GradescopeCourse,
  GradescopeAssignment,
  GradescopeMember,
  GradescopeQueryAnalysis,
};
