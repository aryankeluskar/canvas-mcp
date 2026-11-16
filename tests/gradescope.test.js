import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

describe("Gradescope Integration", () => {
  it("should navigate to Gradescope and open login modal", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({ url: "https://www.gradescope.com" });

    const loginButton = await testdriver.find("the Log In button in the top navigation bar");
    await loginButton.click();

    const assertResult = await testdriver.assert("the Gradescope login dialog with email and password inputs is visible on screen");
    expect(assertResult).toBeTruthy();
  });
});
