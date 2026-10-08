import { describe, expect, it } from "vitest";
import { isAuthorizedAdminRequest } from "./adminAuth.js";

function request(headers: Record<string, string> = {}) {
    return { header: (name: string) => headers[name.toLowerCase()] } as never;
}

describe("administrator authorization", () => {
    it("accepts the existing custom token", () => {
        process.env.ADMIN_DASHBOARD_TOKEN = "owner-secret";
        expect(isAuthorizedAdminRequest(request({ "x-sk-admin-token": "owner-secret" }))).toBe(true);
    });

    it("accepts Basic Auth with the owner secret as the password", () => {
        process.env.ADMIN_DASHBOARD_TOKEN = "owner-secret";
        const credentials = Buffer.from("owner:owner-secret").toString("base64");
        expect(isAuthorizedAdminRequest(request({ authorization: `Basic ${credentials}` }))).toBe(true);
    });

    it("rejects an incorrect Basic Auth password", () => {
        process.env.ADMIN_DASHBOARD_TOKEN = "owner-secret";
        const credentials = Buffer.from("owner:wrong").toString("base64");
        expect(isAuthorizedAdminRequest(request({ authorization: `Basic ${credentials}` }))).toBe(false);
    });
});
