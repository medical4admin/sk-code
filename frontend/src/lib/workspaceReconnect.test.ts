import { describe, expect, it } from "vitest";
import { workspaceReconnectDelay } from "./workspaceReconnect";

describe("workspaceReconnectDelay", () => {
    it("backs off and eventually stops automatic retries", () => {
        expect([0, 1, 2, 3, 4, 5].map(workspaceReconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
        expect(workspaceReconnectDelay(6)).toBeNull();
    });

    it("rejects invalid retry counts", () => {
        expect(workspaceReconnectDelay(-1)).toBeNull();
        expect(workspaceReconnectDelay(1.5)).toBeNull();
    });
});