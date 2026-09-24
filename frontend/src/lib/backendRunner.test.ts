import { describe, expect, it } from "vitest";
import { shouldResetWorkspaceLease } from "./backendRunner";

describe("shouldResetWorkspaceLease", () => {
  it("keeps the workspace lease for device identity issues", () => {
    expect(shouldResetWorkspaceLease("Device identity is required.", 401)).toBe(false);
    expect(shouldResetWorkspaceLease("Origin is not allowed.", 403)).toBe(false);
  });

  it("resets the lease only for workspace session and token problems", () => {
    expect(shouldResetWorkspaceLease("Workspace session expired.", 401)).toBe(true);
    expect(shouldResetWorkspaceLease("Workspace access token is invalid.", 403)).toBe(true);
    expect(shouldResetWorkspaceLease("Forbidden workspace access.", 403)).toBe(true);
  });
});
