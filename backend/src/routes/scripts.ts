import { Router } from "express";
import {
    createScript,
    deleteScript,
    getEnabledScriptsForPath,
    getScript,
    listScripts,
    updateScript,
    type ScriptEntry,
} from "../lib/scriptRegistry.js";
import { isAuthorizedAdminRequest } from "../lib/adminAuth.js";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
    if (!process.env["ADMIN_DASHBOARD_TOKEN"])
        return res.status(404).json({ error: "Administrator dashboard is not configured." });
    if (!isAuthorizedAdminRequest(req))
        return res.status(401).json({ error: "Administrator authorization required." });
    next();
}

function isValidRoute(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 2048;
}

function validateScript(input: Partial<ScriptEntry>) {
    const name = input.name?.trim();
    const code = input.code?.trim();
    const placement = input.placement;
    const scope = input.scope;
    if (!name || name.length > 120 || !code || code.length > 100_000)
        return null;
    if (placement !== "head" && placement !== "body")
        return null;
    if (scope !== "site" && scope !== "route")
        return null;
    if (scope === "route" && input.route !== undefined && !isValidRoute(input.route))
        return null;
    return { name, code, placement, scope, route: input.route?.trim() || undefined, enabled: input.enabled ?? true };
}

router.get("/scripts", requireAdmin, async (_req, res) => {
    res.json({ scripts: await listScripts() });
});

router.get("/scripts/public", async (req, res) => {
    const pathname = req.query.path;
    if (typeof pathname !== "string" || pathname.length === 0 || pathname.includes("\n") || pathname.includes("\r"))
        return res.status(400).json({ error: "A valid path query parameter is required." });
    const scripts = await getEnabledScriptsForPath(pathname);
    res.json({ scripts: scripts.map(({ id, name, code, placement, scope, route, version, updatedAt }) => ({ id, name, code, placement, scope, route, version, updatedAt })) });
});

router.post("/scripts", requireAdmin, async (req, res) => {
    const input = validateScript(req.body ?? {});
    if (!input)
        return res.status(400).json({ error: "Invalid script configuration." });
    const script = await createScript(input);
    res.status(201).json({ script });
});

router.patch("/scripts/:id", requireAdmin, async (req, res) => {
    const input = validateScript(req.body ?? {});
    if (!input)
        return res.status(400).json({ error: "Invalid script configuration." });
    const script = await updateScript(req.params.id, input);
    if (!script)
        return res.status(404).json({ error: "Script not found." });
    res.json({ script });
});

router.delete("/scripts/:id", requireAdmin, async (req, res) => {
    const deleted = await deleteScript(req.params.id);
    if (!deleted)
        return res.status(404).json({ error: "Script not found." });
    res.status(204).send();
});

router.get("/scripts/:id", requireAdmin, async (req, res) => {
    const script = await getScript(req.params.id);
    if (!script)
        return res.status(404).json({ error: "Script not found." });
    res.json({ script });
});

export default router;
