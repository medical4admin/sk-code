export class SerialTaskQueue {
    private pending: Array<{
        userKey: string | null;
        task: () => Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (reason: unknown) => void;
    }> = [];
    private active = 0;
    private outstanding = 0;
    private activeUsers = new Map<string, number>();

    constructor(private readonly maxConcurrent = 1, private readonly maxOutstanding = 20) {
    }

    run<T>(task: () => Promise<T>) {
        if (this.outstanding >= this.maxOutstanding)
            return Promise.reject(new Error("The isolated runner queue is full. Keep working in the browser and retry after queued jobs finish."));
        this.outstanding += 1;
        return new Promise<T>((resolve, reject) => {
            this.pending.push({ userKey: null, task, resolve: resolve as (value: unknown) => void, reject });
            this.drain();
        });
    }

    runForUser<T>(userKey: string, task: () => Promise<T>) {
        if (this.outstanding >= this.maxOutstanding)
            return Promise.reject(new Error("The isolated runner queue is full. Keep working in the browser and retry after queued jobs finish."));
        this.outstanding += 1;
        return new Promise<T>((resolve, reject) => {
            this.pending.push({ userKey, task, resolve: resolve as (value: unknown) => void, reject });
            this.drain();
        });
    }

    status() {
        return { active: this.active, queued: this.pending.length, outstanding: this.outstanding, maxConcurrent: this.maxConcurrent, maxOutstanding: this.maxOutstanding, activeUsers: Object.fromEntries(this.activeUsers) };
    }

    private drain() {
        while (this.active < this.maxConcurrent && this.pending.length > 0) {
            const nextIndex = this.pending.findIndex((item) => item.userKey === null || !this.activeUsers.has(item.userKey));
            if (nextIndex === -1)
                break;
            const queued = this.pending.splice(nextIndex, 1)[0];
            if (queued.userKey) {
                const currentUsers = this.activeUsers.get(queued.userKey) ?? 0;
                this.activeUsers.set(queued.userKey, currentUsers + 1);
            }
            this.active += 1;
            void queued.task().then(queued.resolve, queued.reject).finally(() => {
                this.active -= 1;
                if (queued.userKey) {
                    const after = (this.activeUsers.get(queued.userKey) ?? 1) - 1;
                    if (after <= 0)
                        this.activeUsers.delete(queued.userKey);
                    else
                        this.activeUsers.set(queued.userKey, after);
                }
                this.outstanding -= 1;
                this.drain();
            });
        }
    }
}
