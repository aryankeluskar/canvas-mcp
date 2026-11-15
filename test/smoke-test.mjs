#!/usr/bin/env node
/**
 * Smoke test for the Canvas MCP worker.
 *
 * Exercises the local HTTP MCP server end to end:
 *   - /health responds
 *   - /mcp initialize handshake (Streamable HTTP)
 *   - tools/list returns the expected tool set
 *   - tools/call works (get_cache_stats is fully deterministic)
 *   - get_courses round-trips against the real Canvas API (read-only)
 *     when CANVAS_API_KEY is configured on the server
 *   - get_gradescope_courses content is verified (HTTP 200 alone cannot
 *     indicate success - the MCP layer always answers 200)
 *   - prompts/list, resources/list, server card respond
 *   - unknown tools return a proper JSON-RPC error
 *   - optionally scans server logs for credential leakage
 *
 * Usage:
 *   node test/smoke-test.mjs
 *
 * Environment:
 *   MCP_BASE_URL  base URL of the worker (default http://localhost:8787)
 *   LOG_FILE      optional path to a server log to scan for secrets
 *
 * The test never prints credential values. When scanning logs it loads
 * CANVAS_API_KEY in-process from .dev.vars (if present) and asserts that
 * neither the full token nor any prefix of it appears in the log.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.MCP_BASE_URL || "http://localhost:8787";
const MCP_URL = `${BASE_URL}/mcp`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name} - ${reason}`);
}

async function rpc(method, params, sessionId) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now() % 100000, method, ...(params ? { params } : {}) }),
  });
  return res;
}

async function main() {
  console.log(`Canvas MCP smoke test against ${BASE_URL}\n`);

  // ---------------------------------------------------------------- health
  console.log("Health endpoint:");
  const healthRes = await fetch(`${BASE_URL}/health`);
  const health = await healthRes.json().catch(() => null);
  ok("GET /health returns 200", healthRes.status === 200);
  ok("health payload names the server", health?.name === "Canvas MCP Server", JSON.stringify(health));

  // ----------------------------------------------------------- initialize
  console.log("\nMCP initialize handshake:");
  const initRes = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  const sessionId = initRes.headers.get("Mcp-Session-Id");
  const init = await initRes.json().catch(() => null);
  ok("initialize returns 200", initRes.status === 200);
  ok("initialize returns a session id header", Boolean(sessionId));
  ok(
    "initialize advertises server info",
    init?.result?.serverInfo?.name === "Canvas and Gradescope MCP",
    JSON.stringify(init?.result?.serverInfo)
  );
  ok("initialize protocol version echoed", init?.result?.protocolVersion === "2024-11-05");

  // Acknowledge initialization (notification - no body expected)
  const ackRes = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  ok("initialized notification accepted (empty response)", ackRes.status === 200 && (await ackRes.text()) === "");

  // ------------------------------------------------------------ tools/list
  console.log("\nTool discovery:");
  const toolsRes = await rpc("tools/list", {}, sessionId);
  const tools = await toolsRes.json().catch(() => null);
  const toolNames = (tools?.result?.tools || []).map((t) => t.name);
  ok("tools/list returns 200", toolsRes.status === 200);
  ok("get_courses tool present", toolNames.includes("get_courses"));
  ok("get_cache_stats tool present", toolNames.includes("get_cache_stats"));
  ok("get_courses is annotated read-only", (tools?.result?.tools || []).find((t) => t.name === "get_courses")?.annotations?.readOnlyHint === true);
  const gradescopeConfigured = toolNames.includes("get_gradescope_courses");
  if (gradescopeConfigured) {
    console.log("  NOTE  Gradescope tools present (GRADESCOPE_EMAIL/PASSWORD configured)");
  }

  // -------------------------------------------------- deterministic tool call
  console.log("\nDeterministic tool call (no external API):");
  const cacheRes = await rpc("tools/call", { name: "get_cache_stats", arguments: {} }, sessionId);
  const cache = await cacheRes.json().catch(() => null);
  const cacheText = cache?.result?.content?.[0]?.text;
  const cacheStats = cacheText ? JSON.parse(cacheText) : null;
  ok("get_cache_stats returns 200", cacheRes.status === 200);
  ok("get_cache_stats returns stats object", cacheStats && typeof cacheStats.totalEntries === "number", cacheText);

  // ------------------------------------------------- real Canvas tool call
  console.log("\nCanvas tool call (read-only, uses server-side credentials):");
  const coursesRes = await rpc("tools/call", { name: "get_courses", arguments: {} }, sessionId);
  const courses = await coursesRes.json().catch(() => null);
  const coursesText = courses?.result?.content?.[0]?.text || "";
  if (coursesText.includes("Canvas is not configured")) {
    skip("get_courses", "CANVAS_API_KEY not configured on the server");
  } else {
    let courseCount = 0;
    try {
      courseCount = Object.keys(JSON.parse(coursesText)).length;
    } catch {
      courseCount = -1;
    }
    ok("get_courses returns 200", coursesRes.status === 200);
    ok("get_courses returns at least one course", courseCount > 0, `parsed ${courseCount} courses`);
    if (gradescopeConfigured) {
      // Policy: if the server advertises Gradescope tools, the flow must
      // actually work. The MCP layer always answers HTTP 200, so a
      // tool-level failure hides inside the response body - inspect the
      // content, never the status code. A configured-but-failing Gradescope
      // login is a FAIL, not a skip; silently skipping would be a softer
      // false pass.
      const gsRes = await rpc("tools/call", { name: "get_gradescope_courses", arguments: {} }, sessionId);
      const gs = await gsRes.json().catch(() => null);
      const gsText = gs?.result?.content?.[0]?.text || "";
      let gsParsed = null;
      try {
        gsParsed = JSON.parse(gsText);
      } catch {
        /* tool-level failure text, not JSON */
      }
      ok(
        "get_gradescope_courses returns course data",
        gsParsed !== null &&
          (typeof gsParsed.student === "object" || typeof gsParsed.instructor === "object"),
        gsParsed === null
          ? `tool-level failure inside MCP HTTP ${gsRes.status}: ${gsText.slice(0, 120)}`
          : `unexpected payload: ${gsText.slice(0, 120)}`
      );
    }
  }

  // ---------------------------------------------------------- error paths
  console.log("\nError handling:");
  const badToolRes = await rpc("tools/call", { name: "definitely_not_a_real_tool", arguments: {} }, sessionId);
  const badTool = await badToolRes.json().catch(() => null);
  ok(
    "unknown tool returns JSON-RPC error -32602",
    badTool?.error?.code === -32602,
    JSON.stringify(badTool?.error)
  );

  // ------------------------------------------------------ prompts/resources
  console.log("\nPrompts and resources:");
  const promptsRes = await rpc("prompts/list", {}, sessionId);
  const prompts = await promptsRes.json().catch(() => null);
  ok("prompts/list returns prompts", (prompts?.result?.prompts || []).length > 0);
  const resourcesRes = await rpc("resources/list", {}, sessionId);
  const resources = await resourcesRes.json().catch(() => null);
  ok("resources/list returns resources", (resources?.result?.resources || []).length > 0);

  // ------------------------------------------------------------ server card
  console.log("\nServer card:");
  const cardRes = await fetch(`${BASE_URL}/.well-known/mcp/server-card.json`);
  const card = await cardRes.json().catch(() => null);
  ok("server card responds", cardRes.status === 200 && card?.serverInfo?.name === "Canvas MCP");

  // ------------------------------------------------------ SSE (legacy path)
  console.log("\nLegacy SSE endpoint:");
  try {
    const sseRes = await fetch(`${BASE_URL}/sse`);
    const sseType = sseRes.headers.get("Content-Type") || "";
    ok("GET /sse returns an event stream", sseType.includes("text/event-stream"));
    // Read the initial event then close the stream.
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const firstChunk = new TextDecoder().decode(value);
    ok("SSE stream opens with a session id event", firstChunk.includes("sessionId"));
    await reader.cancel();
  } catch (err) {
    ok("GET /sse returns an event stream", false, String(err));
  }

  // -------------------------------------------------------- secret scanning
  console.log("\nCredential leakage scan:");
  const devVarsPath = join(REPO_ROOT, ".dev.vars");
  if (!existsSync(devVarsPath)) {
    skip("log scan", "no .dev.vars file present");
  } else {
    const logCandidates = [];
    if (process.env.LOG_FILE) logCandidates.push(process.env.LOG_FILE);
    logCandidates.push(
      join(homedir(), "Library", "Logs", "canvas-mcp", "out.log"),
      join(homedir(), "Library", "Logs", "canvas-mcp", "err.log")
    );
    const existingLogs = logCandidates.filter(existsSync);
    if (existingLogs.length === 0) {
      skip("log scan", "no server log files found (set LOG_FILE to scan one)");
    } else {
      // Load the token in-process; never print it.
      const devVars = readFileSync(devVarsPath, "utf8");
      const apiKeyMatch = devVars.match(/^CANVAS_API_KEY\s*=\s*(.+)$/m);
      const apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : null;
      const logText = existingLogs.map((p) => readFileSync(p, "utf8")).join("\n");
      if (!apiKey) {
        skip("log scan", "CANVAS_API_KEY not set in .dev.vars");
      } else {
        const fullLeak = logText.includes(apiKey);
        // Any prefix >= 8 chars appearing in logs counts as a fragment leak.
        const prefixes = [10, 8].map((n) => apiKey.slice(0, n)).filter((p) => p.length >= 8);
        const fragLeak = prefixes.some((p) => logText.includes(p));
        ok("full API token absent from logs", !fullLeak);
        ok("API token fragments absent from logs", !fragLeak);
      }
      ok(
        "config log line uses set/not-set diagnostics",
        logText.includes("canvasApiKey: set") || logText.includes("canvasApiKey: not set"),
        "expected '[Config] canvasApiKey: set/not set' lines"
      );
    }
  }

  // ------------------------------------------------------------------ result
  console.log(`\nResult: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err?.message || err);
  console.error(`Is the worker running at ${BASE_URL}? Start it with: npm start`);
  process.exit(1);
});
