import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCRIPT_METADATA_PATH } from "./backendConfig.js";

export type ScriptPlacement = "head" | "body";
export type ScriptScope = "site" | "route";
export type ScriptEntry = {
    id: string;
    name: string;
    code: string;
    placement: ScriptPlacement;
    scope: ScriptScope;
    route?: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    version: number;
};

type ScriptRegistry = {
    version: 1;
    scripts: ScriptEntry[];
};

let registryCache: ScriptRegistry | null = null;
let writeQueue = Promise.resolve();

function defaultRegistry(): ScriptRegistry {
    return { version: 1, scripts: [] };
}

async function readRegistry(): Promise<ScriptRegistry> {
    if (registryCache)
        return registryCache;
    try {
        const parsed = JSON.parse(await readFile(SCRIPT_METADATA_PATH, "utf8")) as ScriptRegistry;
        registryCache = parsed?.version === 1 && Array.isArray(parsed.scripts) ? parsed : defaultRegistry();
    }
    catch {
        registryCache = defaultRegistry();
    }
    return registryCache;
}

async function persistRegistry() {
    const registry = await readRegistry();
    await mkdir(dirname(SCRIPT_METADATA_PATH), { recursive: true, mode: 0o700 });
    const temporaryPath = join(dirname(SCRIPT_METADATA_PATH), `.scripts-${randomUUID()}.json`);
    await writeFile(temporaryPath, JSON.stringify(registry), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, SCRIPT_METADATA_PATH);
}

function queuePersist() {
    writeQueue = writeQueue.then(() => persistRegistry());
    return writeQueue;
}

export async function listScripts(): Promise<ScriptEntry[]> {
    return (await readRegistry()).scripts.slice().sort((left, right) => left.createdAt - right.createdAt);
}

export async function getScript(id: string): Promise<ScriptEntry | null> {
    return (await readRegistry()).scripts.find((script) => script.id === id) ?? null;
}

export async function createScript(input: Omit<ScriptEntry, "id" | "createdAt" | "updatedAt" | "version">): Promise<ScriptEntry> {
    const registry = await readRegistry();
    const now = Date.now();
    const script: ScriptEntry = {
        ...input,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        version: 1,
    };
    registry.scripts = [...registry.scripts, script];
    await queuePersist();
    return script;
}

export async function updateScript(id: string, input: Partial<Pick<ScriptEntry, "name" | "code" | "placement" | "scope" | "route" | "enabled">>): Promise<ScriptEntry | null> {
    const registry = await readRegistry();
    const script = registry.scripts.find((entry) => entry.id === id);
    if (!script)
        return null;
    Object.assign(script, input, { updatedAt: Date.now(), version: script.version + 1 });
    await queuePersist();
    return script;
}

export async function deleteScript(id: string): Promise<boolean> {
    const registry = await readRegistry();
    const nextScripts = registry.scripts.filter((script) => script.id !== id);
    if (nextScripts.length === registry.scripts.length)
        return false;
    registry.scripts = nextScripts;
    await queuePersist();
    return true;
}

export async function getEnabledScriptsForPath(pathname: string): Promise<ScriptEntry[]> {
    const scripts = await listScripts();
    return scripts.filter((script) => {
        if (!script.enabled)
            return false;
        if (script.scope === "site")
            return true;
        if (!script.route)
            return false;
        const route = script.route.trim().toLowerCase();
        return route === "*" || pathname === route || pathname.startsWith(`${route}/`);
    });
}
