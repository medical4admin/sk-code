import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueuedOperations, drainQueuedOperations, enqueueQueuedOperation, getQueueStatus, getQueuedOperations, isRetrySafeMethod, RetryableQueueError, shouldQueueOperation, subscribeToQueueStatus } from "./operationQueue";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => { memory.clear(); },
  },
  configurable: true,
});

describe("operation queue", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    memory.clear();
    clearQueuedOperations();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("queues backend capacity failures for later retry", () => {
    const message = "Shared server workspace capacity is busy. Source files remain available in browser storage while this server operation waits.";
    expect(shouldQueueOperation(message)).toBe(true);

    const id = enqueueQueuedOperation("workspaceRequest", {
      path: "/execute",
      method: "GET",
      body: { language: "python", code: "print(1)" },
    });

    expect(id).toBeTruthy();
    const queued = JSON.parse(localStorage.getItem("sk-coder-queued-operations-v1") ?? "[]");
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("workspaceRequest");
  });

  it("only replays methods with idempotent semantics", () => {
    expect(isRetrySafeMethod("GET")).toBe(true);
    expect(isRetrySafeMethod("PUT")).toBe(true);
    expect(isRetrySafeMethod("DELETE")).toBe(true);
    expect(isRetrySafeMethod("POST")).toBe(false);
  });

  it("drains queued operations in order", async () => {
    enqueueQueuedOperation("workspaceRequest", {
      path: "/execute",
      method: "GET",
      body: { language: "python", code: "print(1)" },
    });
    enqueueQueuedOperation("workspaceRequest", {
      path: "/execute/sessions/demo",
      method: "GET",
    });

    const calls: string[] = [];
    await drainQueuedOperations(async (operation) => {
      calls.push(operation.path);
      return operation;
    });

    expect(calls).toEqual(["/execute", "/execute/sessions/demo"]);
    expect(JSON.parse(localStorage.getItem("sk-coder-queued-operations-v1") ?? "[]")).toEqual([]);
  });

  it("does not replay stale side-effecting POST entries", async () => {
    enqueueQueuedOperation("workspaceRequest", { path: "/execute/sessions", method: "POST", body: {} });
    enqueueQueuedOperation("workspaceRequest", { path: "/execute/sessions/demo", method: "GET" });
    const calls: string[] = [];
    await drainQueuedOperations(async (operation) => { calls.push(operation.method); return operation; });
    expect(calls).toEqual(["GET"]);
  });

  it("reports the queued waiting state for users", () => {
    enqueueQueuedOperation("workspaceRequest", {
      path: "/execute/sessions/demo",
      method: "GET",
    });
    enqueueQueuedOperation("workspaceRequest", {
      path: "/execute/sessions/demo/heartbeat",
      method: "POST",
      body: { keepAlive: true },
    });

    expect(getQueueStatus()).toMatchObject({
      queued: 2,
      message: expect.stringContaining("saved on this device"),
    });
    expect(getQueueStatus().message).toContain("server has not accepted");
  });

  it("notifies mounted views when browser retry items change", () => {
    let changes = 0;
    const unsubscribe = subscribeToQueueStatus(() => { changes += 1; });
    enqueueQueuedOperation("workspaceRequest", { path: "/execute", method: "POST", body: {} });
    expect(changes).toBe(1);
    clearQueuedOperations();
    expect(changes).toBe(2);
    unsubscribe();
  });

  it("retries transient failures a bounded number of times and drops permanent failures", async () => {
    enqueueQueuedOperation("workspaceRequest", { path: "/temporary", method: "GET" });
    enqueueQueuedOperation("workspaceRequest", { path: "/permanent", method: "GET" });
    await drainQueuedOperations(async (operation) => {
      if (operation.path === "/temporary") throw new RetryableQueueError("backend unavailable");
      throw new Error("invalid request");
    });
    expect(getQueuedOperations()).toMatchObject([{ path: "/temporary", attempts: 1 }]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await drainQueuedOperations(async () => { throw new RetryableQueueError("backend unavailable"); });
    }
    expect(getQueuedOperations()).toEqual([]);
  });
});
