import { describe, expect, it } from "vitest";
import { getStoragePressureState, resolveWorkspaceQuota, USER_BASE_WORKSPACE_BYTES, USER_BURST_WORKSPACE_BYTES, USER_EMERGENCY_WORKSPACE_BYTES } from "./storagePolicy.js";

describe("storage policy", () => {
  it("uses a strict per-user shared workspace budget", () => {
    expect(USER_BASE_WORKSPACE_BYTES).toBe(500 * 1024 * 1024);
    expect(USER_BURST_WORKSPACE_BYTES).toBe(1024 * 1024 * 1024);
    expect(USER_EMERGENCY_WORKSPACE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it("classifies storage pressure states based on usage", () => {
    expect(getStoragePressureState(0.3)).toBe("healthy");
    expect(getStoragePressureState(0.8)).toBe("warning");
    expect(getStoragePressureState(0.9)).toBe("critical");
    expect(getStoragePressureState(0.98)).toBe("emergency");
  });

  it("forces burst storage to remain within the safe shared cap", () => {
    expect(resolveWorkspaceQuota(500 * 1024 * 1024, "healthy")).toBe(500 * 1024 * 1024);
    expect(resolveWorkspaceQuota(500 * 1024 * 1024, "warning")).toBe(500 * 1024 * 1024);
    expect(resolveWorkspaceQuota(500 * 1024 * 1024, "critical")).toBe(500 * 1024 * 1024);
  });
});
