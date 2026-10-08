import { describe, expect, it } from "vitest";
import { getDeviceIdFromRequest, isValidDeviceId } from "./deviceIdentity.js";

describe("device identity", () => {
    it("accepts generated browser identifiers", () => {
        expect(isValidDeviceId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    });

    it("rejects malformed supplied identifiers", () => {
        expect(isValidDeviceId("anonymous!")).toBe(false);
        expect(isValidDeviceId("bad id")).toBe(false);
        expect(isValidDeviceId("a")).toBe(false);
    });

    it("reads a single device identifier from request headers", () => {
        expect(getDeviceIdFromRequest({ "x-device-id": "valid-device-id-1234" })).toBe("valid-device-id-1234");
        expect(getDeviceIdFromRequest({ "x-device-id": ["first", "second"] })).toBe("first");
    });
});
