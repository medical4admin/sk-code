import { useEffect, useState } from "react";

type Script = {
    id: string;
    name: string;
    code: string;
    placement: "head" | "body";
    scope: "site" | "route";
    route?: string;
    enabled: boolean;
    version: number;
    updatedAt: number;
};

const API_BASE = import.meta.env.VITE_OWNER_DASHBOARD_HOST && window.location.hostname === import.meta.env.VITE_OWNER_DASHBOARD_HOST ? "/api" : import.meta.env.VITE_API_URL || "/api";

export default function AdminScriptsPage() {
    const [scripts, setScripts] = useState<Script[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<Script | null>(null);
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [placement, setPlacement] = useState<Script["placement"]>("head");
    const [scope, setScope] = useState<Script["scope"]>("site");
    const [route, setRoute] = useState("");

    const headers = { "Content-Type": "application/json" } as const;

    async function load() {
        setLoading(true);
        setError("");
        try {
            const response = await fetch(`${API_BASE}/scripts`, { headers });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || "Scripts could not be loaded.");
            }
            setScripts((await response.json()).scripts || []);
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : "Owner authentication is required.");
        }
        finally {
            setLoading(false);
        }
    }

    useEffect(() => { void load(); }, []);

    function resetForm(script?: Script) {
        setEditing(script ?? null);
        setName(script?.name || "");
        setCode(script?.code || "");
        setPlacement(script?.placement || "head");
        setScope(script?.scope || "site");
        setRoute(script?.route || "");
    }

    async function save() {
        if (!name.trim() || !code.trim()) {
            setError("A script name and code are required.");
            return;
        }
        if (scope === "route" && !route.trim()) {
            setError("Route-scoped scripts require a route such as /guide or /feedback.");
            return;
        }
        if (code.length > 100_000) {
            setError("A script must be smaller than 100 KB.");
            return;
        }
        const body = { name: name.trim(), code: code.trim(), placement, scope, route: scope === "route" ? route.trim() : undefined, enabled: editing?.enabled ?? true };
        const response = await fetch(editing ? `${API_BASE}/scripts/${encodeURIComponent(editing.id)}` : `${API_BASE}/scripts`, {
            method: editing ? "PATCH" : "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            setError(result.error || "The script could not be saved.");
            return;
        }
        resetForm();
        await load();
    }

    async function toggle(script: Script) {
        const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}`, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !script.enabled }),
        });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            setError(result.error || "The script status could not be changed.");
            return;
        }
        await load();
    }

    async function remove(script: Script) {
        if (!window.confirm(`Delete ${script.name}? This cannot be undone.`))
            return;
        const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(script.id)}`, { method: "DELETE", headers });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            setError(result.error || "The script could not be deleted.");
            return;
        }
        await load();
    }

    return <main className="info-page"><header className="info-header"><h1>Site Scripts</h1><p>Manage scripts for the complete site or selected routes. Scripts execute in visitors' browsers and never run on the server.</p></header><section className="info-section"><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}><button className="btn btn-primary" onClick={() => resetForm()}>New script</button><button className="btn btn-ghost" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>{error && <p style={{ color: "var(--red)", marginBottom: 12 }}>{error}</p>}</section><section className="info-section"><h2>Script editor</h2><div style={{ display: "grid", gap: 12 }}><label>Name<input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Google Analytics" maxLength={120} /></label><label>Placement<select className="select" value={placement} onChange={(event) => setPlacement(event.target.value as Script["placement"])}><option value="head">Document head</option><option value="body">Document body</option></select></label><label>Scope<select className="select" value={scope} onChange={(event) => setScope(event.target.value as Script["scope"])}><option value="site">Whole site</option><option value="route">Selected route or routes</option></select></label>{scope === "route" && <label>Route prefix<input className="input" value={route} onChange={(event) => setRoute(event.target.value)} placeholder="/guide or /feedback" maxLength={2048} /></label>}<label>Script code<textarea className="textarea" value={code} onChange={(event) => setCode(event.target.value)} placeholder="<!-- Google tag (gtag.js) -->&#10;<script async src=...></script>&#10;<script>...</script>" spellCheck={false} /></label><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn btn-primary" onClick={() => void save()} disabled={loading}>{editing ? "Save changes" : "Add script"}</button>{editing && <button className="btn btn-ghost" onClick={() => resetForm()}>Cancel</button>}</div></div><p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 12 }}>Use complete HTML script tags. The code is stored as text and is inserted into visitors' pages; it is not executed by the backend.</p></section><section className="info-section"><h2>Active scripts</h2><div style={{ display: "grid", gap: 10 }}>{scripts.map((script) => <article key={script.id} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg-elevated)" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div><strong>{script.name}</strong><div style={{ color: "var(--text-muted)", fontSize: 11 }}>Version {script.version} · {script.placement} · {script.scope === "site" ? "Whole site" : script.route}</div></div><span style={{ color: script.enabled ? "var(--green)" : "var(--text-muted)" }}>{script.enabled ? "Enabled" : "Disabled"}</span></div><pre style={{ overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-secondary)" }}>{script.code.slice(0, 300)}{script.code.length > 300 ? "…" : ""}</pre><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}><button className="btn btn-ghost" onClick={() => resetForm(script)}>Edit</button><button className="btn btn-ghost" onClick={() => void toggle(script)}>{script.enabled ? "Disable" : "Enable"}</button><button className="btn btn-ghost" onClick={() => void remove(script)}>Delete</button></div></article>)}</div>{scripts.length === 0 && <p style={{ color: "var(--text-muted)" }}>No scripts have been added.</p>}</section></main>;
}
