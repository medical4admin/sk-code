import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorageValues = new Map<string, string>();

function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function loadExecutor() {
    vi.resetModules();
    return import("./executorChain");
}

describe("executorChain public fallback consent", () => {
    beforeEach(() => {
        localStorageValues.clear();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => localStorageValues.get(key) ?? null,
            setItem: (key: string, value: string) => localStorageValues.set(key, value),
            removeItem: (key: string) => localStorageValues.delete(key),
        });
    });

    it("does not send source to a public runner without explicit consent", async () => {
        const fetchMock = vi.fn(async () => response({ error: "runner unavailable" }, 503));
        vi.stubGlobal("fetch", fetchMock);
        const { execute } = await loadExecutor();

        const result = await execute("cpp", "int main() { return 0; }");

        expect(result.tier).toBe("unavailable");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/execute");
    });

    it("uses Wandbox after private runner failure only when explicitly enabled", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === "/api/execute") return response({ error: "runner unavailable" }, 503);
            if (url.endsWith("/api/list.json")) return response([{ name: "gcc-13.2.0" }]);
            if (url.endsWith("/api/compile.json")) return response({ status: "0", program_output: "ok\n" });
            return response({}, 404);
        });
        vi.stubGlobal("fetch", fetchMock);
        const { execute } = await loadExecutor();

        const result = await execute("cpp", "int main() { return 0; }", { allowExternalFallback: true });

        expect(result).toMatchObject({ tier: "public-source", stdout: "ok\n", exitCode: 0 });
        expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/compile.json"))).toBe(true);
    });

    it("does not call the public runner when the private runner succeeds", async () => {
        const fetchMock = vi.fn(async () => response({ stdout: "private\n", stderr: "", exitCode: 0, executionTime: 12 }));
        vi.stubGlobal("fetch", fetchMock);
        const { execute } = await loadExecutor();

        const result = await execute("cpp", "int main() { return 0; }", { allowExternalFallback: true });

        expect(result).toMatchObject({ tier: "workspace-server", stdout: "private\n" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
