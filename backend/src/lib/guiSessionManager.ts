import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BACKEND_INSTANCE_ID, GUI_RUNTIME_IMAGE, GUI_SESSION_MAX_COUNT, GUI_SESSION_MEMORY_MB, GUI_SESSION_TTL_MS } from "./backendConfig.js";
import { authorizeTerminalSession, createWorkspaceSession, destroyWorkspaceSession, getWorkspaceSession } from "./sessionManager.js";
import { beginRuntimeOperationFinalization, completeRuntimeOperationFinalization, createRuntimeOperation, failRuntimeOperationFinalization } from "./operationRegistry.js";

type CommandOutput = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

type GuiSession = {
    id: string;
    deviceId: string;
    workspaceSessionId: string;
    ownsWorkspace: boolean;
    token: string;
    filePath: string | null;
    language: "python" | "java" | null;
    containerName: string | null;
    port: number | null;
    createdAt: number;
    expiresAt: number;
};

const sessions = new Map<string, GuiSession>();
let cleanupStarted = false;

function run(command: string, args: string[], timeout = 30000): Promise<CommandOutput> {
    return new Promise((resolveResult) => {
        const proc = spawn(command, args, { env: { ...process.env, NO_COLOR: "1" } });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 1000).unref();
        }, timeout);
        proc.stdout.on("data", (value: Buffer) => { stdout += value.toString(); });
        proc.stderr.on("data", (value: Buffer) => { stderr += value.toString(); });
        proc.once("error", (error) => {
            clearTimeout(timer);
            resolveResult({ stdout: "", stderr: error.message, exitCode: 127 });
        });
        proc.once("close", (code) => {
            clearTimeout(timer);
            resolveResult({ stdout: stdout.slice(0, 65536), stderr: `${stderr}${timedOut ? "\nCommand timed out." : ""}`.trim(), exitCode: code ?? 1 });
        });
    });
}

function safeRelativePath(pathname: string) {
    const value = normalize(pathname.trim().replace(/^\/+/, "") || ".");
    if (value === "." || value === ".." || value.startsWith("../") || value.startsWith("..\\"))
        throw new Error("A file inside the workspace is required.");
    return value.replaceAll("\\", "/");
}

function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function containerNameFor(id: string) {
    return `skcoder-gui-${id.replaceAll("-", "")}`;
}

function displayPath(session: GuiSession) {
    return `/gui/sessions/${encodeURIComponent(session.id)}/view/${encodeURIComponent(session.token)}/vnc.html?autoconnect=1&resize=scale&reconnect=1`;
}

function publicSession(session: GuiSession) {
    return {
        id: session.id,
        workspaceSessionId: session.workspaceSessionId,
        filePath: session.filePath,
        status: session.containerName ? "running" : "staging",
        expiresAt: session.expiresAt,
        viewPath: session.containerName ? displayPath(session) : null,
    };
}

async function activeGuiCount() {
    const result = await run("docker", ["ps", "--filter", "label=skcoder.gui=true", "--filter", `label=skcoder.instance=${BACKEND_INSTANCE_ID}`, "-q"], 5000);
    return result.stdout.split("\n").filter(Boolean).length;
}

async function getOwnedSession(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    await removeExpiredGuiSessions();
    const session = sessions.get(id);
    if (!session || session.deviceId !== deviceId || !(await authorizeTerminalSession(session.workspaceSessionId, workspaceAccess)))
        throw new Error("Display session not found or expired.");
    return session;
}

function detectLanguage(filePath: string, requested?: string) {
    const value = (requested || extname(filePath).slice(1)).toLowerCase();
    if (value === "py" || value === "python")
        return "python" as const;
    if (value === "java")
        return "java" as const;
    throw new Error("Run with Display currently supports Python Tkinter/Pygame and Java Swing/AWT source files.");
}

async function programCommand(workspacePath: string, filePath: string, language: "python" | "java") {
    const relativePath = safeRelativePath(filePath);
    if (language === "python")
        return `DISPLAY=:99 python3 ${shellQuote(`/workspace/${relativePath}`)}`;
    const source = await readFile(resolve(workspacePath, relativePath), "utf8");
    const packageName = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
    const className = basename(relativePath, ".java");
    const mainClass = packageName ? `${packageName}.${className}` : className;
    return `mkdir -p /tmp/skcoder-java && javac -d /tmp/skcoder-java ${shellQuote(`/workspace/${relativePath}`)} && DISPLAY=:99 java -cp /tmp/skcoder-java ${shellQuote(mainClass)}`;
}

function parseDockerPort(stdout: string): number | null {
    const value = (stdout || "").trim();
    if (!value)
        return null;
    const match = value.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|::):\s*(\d+)/i) ?? value.match(/:(\d+)$/i);
    const port = match?.[1] ? Number(match[1]) : NaN;
    return Number.isSafeInteger(port) && port > 0 ? port : null;
}

async function awaitGuiPort(containerName: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const portResult = await run("docker", ["port", containerName, "6901/tcp"], 5000);
        const parsed = parseDockerPort(portResult.stdout);
        if (parsed)
            return parsed;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const inspectResult = await run("docker", ["inspect", containerName, "--format", "{{json .NetworkSettings.Ports}}"], 10000);
    const inspectPort = Number((inspectResult.stdout.match(/"6901\/tcp":\[[\s\S]*?"HostPort":"?(\d+)"?/)?.[1] ?? "0"));
    if (Number.isSafeInteger(inspectPort) && inspectPort > 0)
        return inspectPort;
    return null;
}

export async function createGuiSession(deviceId: string, workspaceSessionId?: string) {
    await removeExpiredGuiSessions();
    if (await activeGuiCount() >= GUI_SESSION_MAX_COUNT)
        throw new Error("The GUI display queue is full. Try again after the current display session ends.");
    const workspace = workspaceSessionId ? await getWorkspaceSession(workspaceSessionId) : await createWorkspaceSession({ retentionMode: "four-hours" });
    const session: GuiSession = {
        id: randomUUID(),
        deviceId,
        workspaceSessionId: workspace.id,
        ownsWorkspace: !workspaceSessionId,
        token: randomBytes(24).toString("base64url"),
        filePath: null,
        language: null,
        containerName: null,
        port: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + GUI_SESSION_TTL_MS,
    };
    await createRuntimeOperation({ id: `gui:${session.id}`, ownerId: session.id, kind: "gui", resources: [`workspace:${workspace.id}`], expiresAt: session.expiresAt });
    sessions.set(session.id, session);
    startCleanup();
    return publicSession(session);
}

export async function launchGuiSession(id: string, deviceId: string, workspaceAccess: string | null | undefined, filePath: string, requestedLanguage?: string) {
    const session = await getOwnedSession(id, deviceId, workspaceAccess);
    if (session.containerName)
        throw new Error("This display session is already running.");
    if (await activeGuiCount() >= GUI_SESSION_MAX_COUNT)
        throw new Error("The GUI display queue is full. Try again after the current display session ends.");
    const language = detectLanguage(filePath, requestedLanguage);
    const workspace = await getWorkspaceSession(session.workspaceSessionId);
    const relativePath = safeRelativePath(filePath);
    const sourcePath = resolve(workspace.workspacePath, relativePath);
    if (relative(workspace.workspacePath, sourcePath).startsWith(".."))
        throw new Error("Display file path escapes the workspace.");
    await readFile(sourcePath);
    const containerName = containerNameFor(session.id);
    const started = await run("docker", [
        "run", "-d", "--rm", "--name", containerName,
        "--label", "skcoder.gui=true", "--label", `skcoder.gui-id=${session.id}`, "--label", `skcoder.instance=${BACKEND_INSTANCE_ID}`,
        "--memory", `${GUI_SESSION_MEMORY_MB}m`, "--memory-swap", `${GUI_SESSION_MEMORY_MB}m`, "--cpus", "1", "--pids-limit", "192", "--shm-size", "256m",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "1000:1000",
        "-v", `${workspace.workspacePath}:/workspace:ro`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777", "--tmpfs", "/home/coder:rw,nosuid,size=64m,mode=1777",
        "-p", "127.0.0.1:0:6901", GUI_RUNTIME_IMAGE,
    ], 45000);
    if (started.exitCode !== 0)
        throw new Error(started.stderr || "The GUI runtime could not start.");
    const port = await awaitGuiPort(containerName);
    if (!Number.isSafeInteger(port) || port <= 0) {
        const logs = await run("docker", ["logs", "--tail", "200", containerName], 10000);
        await run("docker", ["rm", "-f", containerName], 10000);
        throw new Error(logs.stdout || logs.stderr || "The GUI runtime did not expose a local display port.");
    }
    session.port = port;
    const command = await programCommand(workspace.workspacePath, filePath, language);
    const launched = await run("docker", ["exec", "-d", "--user", "1000:1000", "-e", "DISPLAY=:99", "-w", "/workspace", containerName, "bash", "-lc", `${command} > /tmp/skcoder-program.log 2>&1`], 15000);
    if (launched.exitCode !== 0) {
        await run("docker", ["rm", "-f", containerName], 10000);
        throw new Error(launched.stderr || "The graphical program could not start.");
    }
    session.filePath = filePath;
    session.language = language;
    session.containerName = containerName;
    session.port = session.port ?? port;
    session.expiresAt = Date.now() + GUI_SESSION_TTL_MS;
    await createRuntimeOperation({ id: `gui:${session.id}`, ownerId: session.id, kind: "gui", resources: [`workspace:${session.workspaceSessionId}`, `container:${containerName}`], expiresAt: session.expiresAt });
    return publicSession(session);
}

export async function getGuiDisplayTarget(id: string, token: string) {
    await removeExpiredGuiSessions();
    const session = sessions.get(id);
    if (!session || session.token !== token || !session.port || !session.containerName)
        throw new Error("Display session not found or expired.");
    return { port: session.port };
}

export async function getGuiSessionStatus(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    const session = await getOwnedSession(id, deviceId, workspaceAccess);
    let log = "";
    if (session.containerName) {
        const result = await run("docker", ["exec", "--user", "1000:1000", session.containerName, "bash", "-lc", "tail -c 16384 /tmp/skcoder-program.log 2>/dev/null || true"], 10000);
        log = result.stdout;
    }
    return { ...publicSession(session), log };
}

export async function stopGuiSession(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    const session = await getOwnedSession(id, deviceId, workspaceAccess);
    await removeGuiSession(session);
}

async function removeGuiSession(session: GuiSession) {
    sessions.delete(session.id);
    await beginRuntimeOperationFinalization(`gui:${session.id}`, session.id, "gui");
    try {
        if (session.containerName)
            await run("docker", ["rm", "-f", session.containerName], 10000);
        if (session.ownsWorkspace)
            await destroyWorkspaceSession(session.workspaceSessionId);
        await completeRuntimeOperationFinalization(`gui:${session.id}`, session.id, "gui");
    }
    catch (error) {
        await failRuntimeOperationFinalization(`gui:${session.id}`, session.id, error);
        throw error;
    }
}

export async function removeExpiredGuiSessions() {
    const now = Date.now();
    for (const session of [...sessions.values()])
        if (session.expiresAt <= now)
            await removeGuiSession(session);
}

function startCleanup() {
    if (cleanupStarted)
        return;
    cleanupStarted = true;
    const timer = setInterval(() => void removeExpiredGuiSessions(), 30000);
    timer.unref();
}
