import { readFile } from "node:fs/promises";
import process from "node:process";

const configPath = process.argv[2];

if (!configPath) {
    console.error("Provide a deployment environment file path.");
    process.exit(2);
}

const values = new Map();
const source = await readFile(configPath, "utf8");

for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
        continue;
    const separator = trimmed.indexOf("=");
    if (separator > 0)
        values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
}

const errors = [];
const required = ["BACKEND_PORT", "ALLOWED_ORIGINS", "RUNTIME_IMAGE", "WORKSPACE_MAX_BYTES", "WORKSPACE_SAFETY_RESERVE_BYTES", "SHARED_POOL_MAX_BYTES", "SHARED_POOL_ADMISSION_BYTES", "WORKSPACE_INITIAL_RESERVATION_BYTES", "WORKSPACE_INSTALL_RESERVE_BYTES", "RUNNER_SCRATCH_MAX_BYTES", "STAGING_MAX_BYTES", "RUNTIME_CACHE_MAX_BYTES", "PACKAGE_CACHE_MAX_BYTES", "LOG_MAX_BYTES", "HOST_OVERHEAD_BYTES", "SESSION_MAX_BYTES", "SESSION_MAX_COUNT", "APK_JOB_MIN_RESERVATION_BYTES", "APK_JOB_MAX_RESERVATION_BYTES", "APK_JOB_EXPANSION_MULTIPLIER"];

for (const key of required) {
    if (!values.get(key))
        errors.push(`${key} is required.`);
}

const runtimeImage = values.get("RUNTIME_IMAGE") || "";
const isVerifiedDigest = runtimeImage.includes("@sha256:") && !/(?:latest|replace|your_)/i.test(runtimeImage);
const isVerifiedLocalOracleImage = runtimeImage === "sk-coder-runtime:oracle-arm64";
if (!isVerifiedDigest && !isVerifiedLocalOracleImage)
    errors.push("RUNTIME_IMAGE must use a verified immutable @sha256 digest or the locally built sk-coder-runtime:oracle-arm64 tag after target-host verification.");

const allowedOrigins = (values.get("ALLOWED_ORIGINS") || "").split(",").map((value) => value.trim()).filter(Boolean);
if (!allowedOrigins.length)
    errors.push("ALLOWED_ORIGINS must contain at least one final HTTPS browser origin.");
for (const origin of allowedOrigins) {
    if (!/^https:\/\/[^/]+$/i.test(origin) || /(?:\*|localhost|127\.0\.0\.1|yourdomain|example\.com)/i.test(origin))
        errors.push(`ALLOWED_ORIGINS contains an unsafe or placeholder origin: ${origin}`);
}

for (const key of ["BACKEND_PORT", "WORKSPACE_MAX_BYTES", "WORKSPACE_SAFETY_RESERVE_BYTES", "SHARED_POOL_MAX_BYTES", "SHARED_POOL_ADMISSION_BYTES", "WORKSPACE_INITIAL_RESERVATION_BYTES", "WORKSPACE_INSTALL_RESERVE_BYTES", "RUNNER_SCRATCH_MAX_BYTES", "STAGING_MAX_BYTES", "RUNTIME_CACHE_MAX_BYTES", "PACKAGE_CACHE_MAX_BYTES", "LOG_MAX_BYTES", "HOST_OVERHEAD_BYTES", "SESSION_MAX_BYTES", "SESSION_MAX_COUNT", "APK_JOB_MIN_RESERVATION_BYTES", "APK_JOB_MAX_RESERVATION_BYTES", "APK_JOB_EXPANSION_MULTIPLIER"]) {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value <= 0)
        errors.push(`${key} must be a positive integer.`);
}

const workspaceBytes = Number(values.get("WORKSPACE_MAX_BYTES"));
const safetyReserveBytes = Number(values.get("WORKSPACE_SAFETY_RESERVE_BYTES"));
const runnerScratchBytes = Number(values.get("RUNNER_SCRATCH_MAX_BYTES"));
const stagingBytes = Number(values.get("STAGING_MAX_BYTES"));
const runtimeCacheBytes = Number(values.get("RUNTIME_CACHE_MAX_BYTES"));
const packageCacheBytes = Number(values.get("PACKAGE_CACHE_MAX_BYTES"));
const logBytes = Number(values.get("LOG_MAX_BYTES"));
const hostOverheadBytes = Number(values.get("HOST_OVERHEAD_BYTES"));
const sessionBytes = Number(values.get("SESSION_MAX_BYTES"));
const apkMaxReservationBytes = Number(values.get("APK_JOB_MAX_RESERVATION_BYTES"));
const instanceStorageBytes = 150 * 1024 * 1024 * 1024;
const fixedRuntimeBytes = runnerScratchBytes + stagingBytes + runtimeCacheBytes + packageCacheBytes + logBytes + sessionBytes + apkMaxReservationBytes + hostOverheadBytes;
if (workspaceBytes + safetyReserveBytes + fixedRuntimeBytes !== instanceStorageBytes)
    errors.push(`Storage allocation must total exactly 150 GB: workspace + safety reserve + fixed runtime capacity = ${workspaceBytes + safetyReserveBytes + fixedRuntimeBytes} bytes.`);

const sharedPoolBytes = Number(values.get("SHARED_POOL_MAX_BYTES"));
const admissionBytes = Number(values.get("SHARED_POOL_ADMISSION_BYTES"));
if (Number.isSafeInteger(sharedPoolBytes) && Number.isSafeInteger(admissionBytes) && admissionBytes > sharedPoolBytes)
    errors.push("SHARED_POOL_ADMISSION_BYTES cannot exceed SHARED_POOL_MAX_BYTES.");
if (Number.isSafeInteger(sharedPoolBytes) && Number.isSafeInteger(admissionBytes) && admissionBytes === sharedPoolBytes)
    errors.push("SHARED_POOL_ADMISSION_BYTES must leave continuation capacity below SHARED_POOL_MAX_BYTES.");
if (Number.isSafeInteger(workspaceBytes) && Number(values.get("WORKSPACE_INITIAL_RESERVATION_BYTES")) > workspaceBytes)
    errors.push("WORKSPACE_INITIAL_RESERVATION_BYTES cannot exceed WORKSPACE_MAX_BYTES.");
if (Number.isSafeInteger(workspaceBytes) && Number(values.get("WORKSPACE_INSTALL_RESERVE_BYTES")) > workspaceBytes)
    errors.push("WORKSPACE_INSTALL_RESERVE_BYTES cannot exceed WORKSPACE_MAX_BYTES.");

if (errors.length) {
    console.error("Production configuration is not ready:");
    for (const error of errors)
        console.error(`- ${error}`);
    process.exit(1);
}

console.log("Production configuration passed source-level validation.");
