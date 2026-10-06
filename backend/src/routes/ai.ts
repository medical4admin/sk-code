import { Router } from "express";
import fs from "fs";
import path from "path";
const router = Router();
const DATA_DIR = path.join(process.cwd(), "backend_data");
const PROXY_ENDPOINTS = new Set([
    "https://api.openai.com/v1",
    "https://api.groq.com/openai/v1",
    "https://openrouter.ai/api/v1",
    "https://api.aerolink.lat/v1",
]);
const AEROLINK_ENDPOINT = "https://api.aerolink.lat/v1";
function loadProjectContext(projectId: string, deviceId: string, selectedPaths: string[] = []) {
    if (!projectId)
        return "";
    const p = path.join(DATA_DIR, `${projectId}.json`);
    if (!fs.existsSync(p))
        return "";
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.deviceId !== deviceId)
        return "";
    const files = (data.files || []).filter((file: any) => selectedPaths.includes(file.path));
    if (!files.length)
        return "";
    return files.map((file: any) => `File: ${file.path}\n\n${String(file.content || "").slice(0, 4000)}`).join("\n\n---\n\n");
}
router.post("/ai/chat", async (req: any, res) => {
    const { apiKey, provider, prompt, messages, systemPrompt, projectId, selectedPaths, model, endpoint } = req.body;
    const userPrompt = typeof prompt === "string" ? prompt : (messages?.[messages.length - 1]?.content || "");
    if (!apiKey || !userPrompt)
        return res.status(400).json({ error: "apiKey and prompt required" });
    const apiBase = typeof endpoint === "string" && endpoint.trim()
        ? endpoint.trim().replace(/\/$/, "")
        : "https://api.openai.com/v1";
    if (!PROXY_ENDPOINTS.has(apiBase))
        return res.status(400).json({ error: "This compatible endpoint is called directly from the browser and must allow browser CORS. The secure workspace proxy only supports built-in provider endpoints." });
    const isAerolink = apiBase === AEROLINK_ENDPOINT;
    const apiEndpoint = isAerolink ? `${apiBase}/messages` : apiBase.endsWith("/chat/completions") ? apiBase : `${apiBase}/chat/completions`;
    let enrichedPrompt = userPrompt;
    const context = loadProjectContext(projectId, req.deviceId, selectedPaths || []);
    if (context) {
        enrichedPrompt = `${userPrompt}\n\nWorkspace context:\n${context}`;
    }
    const conversation = Array.isArray(messages)
        ? messages.slice(-30).filter((message: unknown): message is { role: string; content: string } => Boolean(message && typeof message === "object" && ["user", "assistant"].includes((message as { role?: string }).role || "") && typeof (message as { content?: unknown }).content === "string"))
        : [];
    if (conversation.length) conversation[conversation.length - 1] = { ...conversation[conversation.length - 1], content: enrichedPrompt };
    try {
        const r = await fetch(apiEndpoint, {
            method: "POST",
            headers: isAerolink ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(isAerolink
                ? { model: model || "claude-haiku-4-5-20251001", max_tokens: 4096, system: systemPrompt || "You are SK Coder AI assistant. Help users write, debug, and improve their code.", messages: conversation.length ? conversation : [{ role: "user", content: enrichedPrompt }] }
                : { model: model || "gpt-4o-mini", messages: [{ role: "system", content: systemPrompt || "You are SK Coder AI assistant. Help users write, debug, and improve their code." }, ...(conversation.length ? conversation : [{ role: "user", content: enrichedPrompt }])] }),
            signal: AbortSignal.timeout(60000),
        });
        const j = await r.json().catch(() => ({})) as any;
        if (!r.ok) return res.status(r.status).json(j);
        const content = j?.choices?.[0]?.message?.content || (Array.isArray(j?.content) ? j.content.map((item: { text?: string }) => item.text || "").join("") : "") || j?.content || j?.message?.content || "";
        if (!content && j?.error)
            return res.status(502).json(j);
        res.json({ content, usage: j?.usage, usageMetadata: j?.usageMetadata, cost: j?.cost });
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
export default router;
