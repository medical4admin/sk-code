const MAX_AUTOMATIC_RETRIES = 6;

export function workspaceReconnectDelay(attempt: number): number | null {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_AUTOMATIC_RETRIES)
        return null;
    return Math.min(10_000, 500 * 2 ** attempt);
}