import { beforeEach, describe, expect, it } from "vitest";
import { clearQueuedOperations, drainQueuedOperations, enqueueQueuedOperation, getQueueStatus, shouldQueueOperation } from "./operationQueue";

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
    memory.clear();
    clearQueuedOperations();
  });

  it("queues backend capacity failures for later retry", () => {
    const message = "Shared server workspace capacity is busy. Source files remain available in browser storage while this server operation waits.";
    expect(shouldQueueOperation(message)).toBe(true);

    const id = enqueueQueuedOperation("workspaceRequest", {
      path: "/execute",
      method: "POST",
      body: { language: "python", code: "print(1)" },
    });

    expect(id).toBeTruthy();
    const queued = JSON.parse(localStorage.getItem("sk-coder-queued-operations-v1") ?? "[]");
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("workspaceRequest");
  });

  it("drains queued operations in order", async () => {
    enqueueQueuedOperation("workspaceRequest", {
      path: "/execute",
      method: "POST",
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
      message: expect.stringMatching(/queued|waiting|busy/i),
    });
  });
});
