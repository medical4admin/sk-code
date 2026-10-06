import { describe, expect, it } from "vitest";
import { parseAIUsage } from "./aiClient";

describe("parseAIUsage", () => {
    it("normalizes OpenAI token counts and exact provider-reported cost", () => {
        expect(parseAIUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0025 } })).toEqual({
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            costUsd: 0.0025,
        });
    });

    it("normalizes Anthropic and Gemini usage metadata", () => {
        expect(parseAIUsage({ usage: { input_tokens: 11, output_tokens: 7 } })).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: undefined });
        expect(parseAIUsage({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 9, totalTokenCount: 29 } })).toEqual({ inputTokens: 20, outputTokens: 9, totalTokens: 29, costUsd: undefined });
    });

    it("ignores missing, negative, and non-finite usage fields", () => {
        expect(parseAIUsage({ usage: { prompt_tokens: -1, completion_tokens: "3" } })).toBeUndefined();
        expect(parseAIUsage(null)).toBeUndefined();
    });
});
