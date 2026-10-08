import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

function constantTimeEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function getBasicAuthCredentials(header: string | undefined): { username: string; password: string } | null {
    if (!header?.startsWith("Basic "))
        return null;
    try {
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 1)
            return null;
        return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
    }
    catch {
        return null;
    }
}

export function isAuthorizedAdminRequest(req: Request): boolean {
    const expected = process.env["ADMIN_DASHBOARD_TOKEN"];
    if (!expected)
        return false;
    const customToken = req.header("x-sk-admin-token");
    if (customToken && constantTimeEqual(customToken, expected))
        return true;
    const credentials = getBasicAuthCredentials(req.header("authorization"));
    return Boolean(credentials && constantTimeEqual(credentials.password, expected));
}
