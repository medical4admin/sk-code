import { describe, expect, it } from "vitest";
import { resolveActiveAIProfile, upsertAIProfile } from "./aiClient";

describe("AI connection profiles", () => {
    it("prefers the active saved profile when multiple connections exist", () => {
        const profiles = [
            { id: "1", label: "Claude", provider: "anthropic", model: "claude-3-7-sonnet", apiKey: "k1", endpoint: "", active: false },
            { id: "2", label: "OpenAI", provider: "openai", model: "gpt-4o", apiKey: "k2", endpoint: "", active: true },
        ];

        expect(resolveActiveAIProfile(profiles)).toMatchObject({ id: "2", model: "gpt-4o" });
    });

    it("adds a new profile without duplicating the same model/provider slot", () => {
        const profiles = [
            { id: "1", label: "Claude", provider: "anthropic", model: "claude-3-7-sonnet", apiKey: "k1", endpoint: "", active: true },
        ];

        const next = upsertAIProfile(profiles, {
            id: "2",
            label: "Claude 2",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            apiKey: "k2",
            endpoint: "",
            active: false,
        });

        expect(next).toHaveLength(2);
        expect(next.some((profile) => profile.model === "claude-3-7-sonnet" && profile.apiKey === "k2")).toBe(true);
    });
});
