import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serialTaskQueue.js";

describe("serial task queue", () => {
    it("starts a later task only after the active task settles", async () => {
        const queue = new SerialTaskQueue();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = queue.run(async () => {
            events.push("first:start");
            await gate;
            events.push("first:end");
        });
        const second = queue.run(async () => { events.push("second:start"); });
        await Promise.resolve();
        expect(events).toEqual(["first:start"]);
        release();
        await Promise.all([first, second]);
        expect(events).toEqual(["first:start", "first:end", "second:start"]);
    });

    it("rejects new work once its bounded outstanding limit is reached", async () => {
        const queue = new SerialTaskQueue(1, 1);
        let release!: () => void;
        const first = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
        await expect(queue.run(async () => undefined)).rejects.toThrow("queue is full");
        release();
        await first;
    });

    it("honors configured concurrent worker capacity", async () => {
        const queue = new SerialTaskQueue(2, 3);
        const events: string[] = [];
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const first = queue.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; events.push("first:start"); }));
        const second = queue.run(() => new Promise<void>((resolve) => { releaseSecond = resolve; events.push("second:start"); }));
        await Promise.resolve();
        expect(events).toEqual(["first:start", "second:start"]);
        releaseFirst();
        releaseSecond();
        await Promise.all([first, second]);
    });

    it("keeps one active task per user while allowing other users to proceed", async () => {
        const queue = new SerialTaskQueue(2, 4);
        const events: string[] = [];
        let releaseUserOne!: () => void;
        let releaseUserTwo!: () => void;
        const first = queue.runForUser("user-a", () => new Promise<void>((resolve) => {
            events.push("user-a:start");
            releaseUserOne = resolve;
        }));
        const second = queue.runForUser("user-a", () => new Promise<void>((resolve) => {
            events.push("user-a:queued");
            resolve();
        }));
        const third = queue.runForUser("user-b", () => new Promise<void>((resolve) => {
            events.push("user-b:start");
            releaseUserTwo = resolve;
        }));
        await Promise.resolve();
        expect(events).toEqual(["user-a:start", "user-b:start"]);
        releaseUserOne();
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toEqual(["user-a:start", "user-b:start", "user-a:queued"]);
        releaseUserTwo();
        await Promise.all([first, second, third]);
    });
});
