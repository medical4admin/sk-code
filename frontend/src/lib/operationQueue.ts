export type QueuedOperation = {
  id: string;
  kind: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  queuedAt: number;
};

const QUEUE_STORAGE_KEY = "sk-coder-queued-operations-v1";
const CAPACITY_FAILURE_PATTERNS = [
  "capacity is busy",
  "workspace capacity",
  "shared server workspace capacity is busy",
  "all active runtime slots are busy",
  "preserving its safety reserve",
  "preserving memory for active work",
  "queued jobs finish",
  "queue is full",
  "runtime service is not available",
  "temporarily unavailable",
  "try again after",
];
const MEMORY_STORAGE = new Map<string, string>();

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }
  return null;
}

export function shouldQueueOperation(message: string): boolean {
  const normalized = message.toLowerCase();
  return CAPACITY_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function getQueuedOperations(): QueuedOperation[] {
  try {
    const storage = getStorage();
    const raw = storage ? storage.getItem(QUEUE_STORAGE_KEY) : MEMORY_STORAGE.get(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedOperation[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && typeof item.path === "string") : [];
  } catch {
    return [];
  }
}

export function getQueueStatus() {
  const queued = getQueuedOperations();
  if (queued.length === 0) {
    return {
      queued: 0,
      waiting: false,
      message: "There are no queued workspace operations right now.",
    };
  }
  const oldestQueuedAt = queued.reduce((lowest, item) => Math.min(lowest, item.queuedAt), queued[0].queuedAt);
  const message = queued.length === 1
    ? "1 queued workspace action is waiting for available capacity."
    : `${queued.length} queued workspace actions are waiting for available capacity.`;
  return {
    queued: queued.length,
    waiting: true,
    oldestQueuedAt,
    message,
  };
}

export function clearQueuedOperations() {
  const storage = getStorage();
  if (storage) storage.removeItem(QUEUE_STORAGE_KEY);
  else MEMORY_STORAGE.delete(QUEUE_STORAGE_KEY);
}

export function enqueueQueuedOperation(kind: string, payload: Pick<QueuedOperation, "path" | "method" | "body" | "headers">): string {
  const queued = getQueuedOperations();
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const item: QueuedOperation = {
    id,
    kind,
    path: payload.path,
    method: payload.method,
    body: payload.body,
    headers: payload.headers,
    queuedAt: Date.now(),
  };
  queued.push(item);
  const storage = getStorage();
  if (storage) storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queued));
  else MEMORY_STORAGE.set(QUEUE_STORAGE_KEY, JSON.stringify(queued));
  return id;
}

export async function drainQueuedOperations<T>(executor: (operation: QueuedOperation) => Promise<T>): Promise<T[]> {
  const queued = getQueuedOperations();
  if (!queued.length) return [];
  const operations = [...queued];
  clearQueuedOperations();
  const results: T[] = [];
  for (const operation of operations) {
    try {
      results.push(await executor(operation));
    } catch {
      const remaining = getQueuedOperations();
      remaining.push(operation);
      const storage = getStorage();
      if (storage) storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(remaining));
      else MEMORY_STORAGE.set(QUEUE_STORAGE_KEY, JSON.stringify(remaining));
    }
  }
  return results;
}
