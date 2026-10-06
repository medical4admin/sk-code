export type QueuedOperation = {
  id: string;
  kind: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  queuedAt: number;
  attempts?: number;
};

const QUEUE_STORAGE_KEY = "sk-coder-queued-operations-v1";
const QUEUE_CHANGE_EVENT = "sk-coder:queue-changed";
const MAX_QUEUE_ATTEMPTS = 4;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;
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

function publishQueueChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_CHANGE_EVENT));
}

export function subscribeToQueueStatus(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(QUEUE_CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(QUEUE_CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function saveQueuedOperations(queued: QueuedOperation[]) {
  const storage = getStorage();
  if (storage) storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queued));
  else MEMORY_STORAGE.set(QUEUE_STORAGE_KEY, JSON.stringify(queued));
  publishQueueChange();
}

export function shouldQueueOperation(message: string): boolean {
  const normalized = message.toLowerCase();
  return CAPACITY_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export class RetryableQueueError extends Error {}
export class QueuedLocallyError extends Error {}

export function isRetrySafeMethod(method: string) {
  return method === "GET" || method === "PUT" || method === "DELETE";
}

export function getQueuedOperations(): QueuedOperation[] {
  try {
    const storage = getStorage();
    const raw = storage ? storage.getItem(QUEUE_STORAGE_KEY) : MEMORY_STORAGE.get(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedOperation[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && typeof item.path === "string" && Number.isFinite(item.queuedAt) && Date.now() - item.queuedAt < MAX_QUEUE_AGE_MS && (item.attempts ?? 0) < MAX_QUEUE_ATTEMPTS) : [];
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
    ? "1 workspace request is saved on this device for retry; the server has not accepted it yet."
    : `${queued.length} workspace requests are saved on this device for retry; the server has not accepted them yet.`;
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
  publishQueueChange();
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
  saveQueuedOperations(queued);
  return id;
}

export async function drainQueuedOperations<T>(executor: (operation: QueuedOperation) => Promise<T>): Promise<T[]> {
  const queued = getQueuedOperations();
  if (!queued.length) return [];
  const operations = queued.filter((operation) => isRetrySafeMethod(operation.method));
  clearQueuedOperations();
  const results: T[] = [];
  for (const operation of operations) {
    try {
      results.push(await executor(operation));
    } catch (error) {
      const remaining = getQueuedOperations();
      if (error instanceof RetryableQueueError && (operation.attempts ?? 0) + 1 < MAX_QUEUE_ATTEMPTS) {
        remaining.push({ ...operation, attempts: (operation.attempts ?? 0) + 1 });
        saveQueuedOperations(remaining);
      }
    }
  }
  return results;
}
