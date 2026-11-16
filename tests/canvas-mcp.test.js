import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

describe("Canvas MCP Server", () => {
  it("should display server health and metadata", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: "https://canvas-mcp.soyrun.workers.dev" });

    const assertResult = await testdriver.assert("the Canvas MCP Server JSON response containing version and endpoints is visible on screen");
    expect(assertResult).toBeTruthy();
  });

  it("should serve the MCP server card configuration", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: "https://canvas-mcp.soyrun.workers.dev/.well-known/mcp/server-card.json" });

    const assertResult = await testdriver.assert("the server-card JSON showing serverInfo and configurationSchema with Canvas and Gradescope parameters is visible on screen");
    expect(assertResult).toBeTruthy();
  });
});
