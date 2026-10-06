import { describe, expect, it } from "vitest";
import { routeMatchesScript } from "./scriptLoader";

describe("routeMatchesScript", () => {
    it("matches the whole site scripts", () => {
        expect(routeMatchesScript({ scope: "site", route: undefined }, "/guide")).toBe(true);
    });

    it("matches exact and nested route paths", () => {
        expect(routeMatchesScript({ scope: "route", route: "/feedback" }, "/feedback")).toBe(true);
        expect(routeMatchesScript({ scope: "route", route: "/feedback" }, "/feedback/bugs")).toBe(true);
        expect(routeMatchesScript({ scope: "route", route: "/feedback" }, "/privacy")).toBe(false);
    });
});
