export const USER_BASE_WORKSPACE_BYTES = 500 * 1024 * 1024;
export const USER_BURST_WORKSPACE_BYTES = 1024 * 1024 * 1024;
export const USER_EMERGENCY_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;

export type StoragePressureState = "healthy" | "warning" | "critical" | "emergency";

export function getStoragePressureState(usedRatio: number): StoragePressureState {
  if (usedRatio >= 0.98)
    return "emergency";
  if (usedRatio >= 0.9)
    return "critical";
  if (usedRatio >= 0.8)
    return "warning";
  return "healthy";
}

export function resolveWorkspaceQuota(currentBytes: number, pressure: StoragePressureState) {
  const base = Math.min(currentBytes, USER_BASE_WORKSPACE_BYTES);
  if (pressure === "emergency")
    return base;
  if (pressure === "critical")
    return base;
  if (pressure === "warning")
    return base;
  return Math.min(currentBytes, USER_BASE_WORKSPACE_BYTES + USER_BURST_WORKSPACE_BYTES);
}
