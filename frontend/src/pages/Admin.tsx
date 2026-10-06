import { useEffect, useState } from "react";

const ownerDashboardHost = import.meta.env.VITE_OWNER_DASHBOARD_HOST;
const API_BASE = ownerDashboardHost && window.location.hostname === ownerDashboardHost ? "/api" : import.meta.env.VITE_API_URL || "/api";

type Workspace = { id: string; createdAt: number; lastHeartbeatAt: number; expiresAt: number; state: "active" | "scheduled-delete" | "deleted"; quotaBytes: number; revision: number };
type Metric = { generatedAt: number; reservedBytes: number; actualBytes: number; diskUsedBytes: number; memoryUsedBytes: number; load1: number };
type Summary = {
    generatedAt: number;
    activeRuntimeSessions: number;
    runnerQueue: { active: number; queued: number; outstanding: number; maxConcurrent: number; maxOutstanding: number };
    workspaces: { total: number; active: number; scheduledDelete: number; deleted: number; retainedQuotaBytes: number };
    operational: {
        host: { memory: { totalBytes: number; availableBytes: number; usedBytes: number }; disk: { totalBytes: number; freeBytes: number; usedBytes: number }; cpu: { logicalCpus: number; load1: number; load5: number; load15: number } };
        sharedPool: { maximumBytes: number; admissionBytes: number; extensionBytes: number; reservedBytes: number; actualBytes: number; availableAdmissionBytes: number; availableExtensionBytes: number; activeReservations: number; releaseFailures: number; byKind: Array<{ kind: string; reservedBytes: number; actualBytes: number; active: number }> };
        operations: { active: number; cleanupFailed: number; finalized: number; expired: number };
        containers: Array<{ name: string; cpu: string; memory: string; pids: number }>;
        history: Metric[];
    };
};

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function formatTime(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
function percent(value: number, total: number) {
    return total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
}
function Ring({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
    const valuePercent = percent(value, total);
    return <div style={{ display: "grid", gridTemplateColumns: "78px 1fr", gap: 12, alignItems: "center", padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg-elevated)" }}>
      <div style={{ width: 78, height: 78, borderRadius: "50%", display: "grid", placeItems: "center", background: `conic-gradient(${tone} ${valuePercent}%, var(--border) 0)` }}>
        <span style={{ width: 58, height: 58, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--bg-elevated)", fontSize: 12, fontWeight: 700 }}>{valuePercent.toFixed(0)}%</span>
      </div>
      <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div><strong style={{ fontSize: 18 }}>{formatBytes(value)}</strong><div style={{ fontSize: 12, color: "var(--text-muted)" }}>of {formatBytes(total)}</div></div>
    </div>;
}
function Bars({ values, color }: { values: number[]; color: string }) {
    const maximum = Math.max(1, ...values);
    return <div style={{ height: 48, display: "flex", alignItems: "end", gap: 3 }}>{values.slice(-40).map((value, index) => <span key={index} style={{ width: 5, flex: 1, maxWidth: 9, minHeight: 3, height: `${Math.max(3, value / maximum * 48)}px`, background: color, borderRadius: 2 }} />)}</div>;
}
function MetricCard({ label, value }: { label: string; value: string }) {
    return <div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div><strong>{value}</strong></div>;
}

export default function AdminPage() {
    const [token, setToken] = useState("");
    const [summary, setSummary] = useState<Summary | null>(null);
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const headers = { "X-SK-Admin-Token": token };
    async function load() {
        if (!token) return;
        setLoading(true);
        setError("");
        try {
            const [summaryResponse, workspaceResponse] = await Promise.all([fetch(`${API_BASE}/admin/summary`, { headers }), fetch(`${API_BASE}/admin/workspaces`, { headers })]);
            if (!summaryResponse.ok || !workspaceResponse.ok) {
                const body = await summaryResponse.json().catch(() => ({}));
                throw new Error(body.error || "Administrator access was denied.");
            }
            setSummary(await summaryResponse.json());
            setWorkspaces((await workspaceResponse.json()).workspaces || []);
        }
        catch (reason) {
            setSummary(null);
            setWorkspaces([]);
            setError(reason instanceof Error ? reason.message : "Administrator data could not be loaded.");
        }
        finally { setLoading(false); }
    }
    async function scheduleDelete(workspace: Workspace) {
        const confirmation = window.prompt(`Type this workspace ID to schedule its deletion in four hours:\n${workspace.id}`);
        if (confirmation !== workspace.id) return;
        const response = await fetch(`${API_BASE}/admin/workspaces/${encodeURIComponent(workspace.id)}/schedule-delete`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ confirmWorkspaceId: confirmation }) });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setError(body.error || "Workspace cleanup could not be scheduled.");
            return;
        }
        await load();
    }
    useEffect(() => { if (token) void load(); }, [token]);
    if (!token) return <main className="info-page"><header className="info-header"><h1>Administrator Dashboard</h1><p>Enter the owner dashboard token to view live operational metrics.</p></header><section className="info-section" style={{ maxWidth: 520 }}><div style={{ display: "grid", gap: 10 }}><label htmlFor="owner-dashboard-token">Dashboard token</label><input id="owner-dashboard-token" className="input" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} /><button className="btn btn-primary" onClick={() => void load()} disabled={!token}>Open dashboard</button></div></section></main>;
    const pool = summary?.operational.sharedPool;
    const host = summary?.operational.host;
    const history = summary?.operational.history || [];
    return <main className="info-page"><header className="info-header"><h1>Administrator Dashboard</h1><p>Owner-only capacity, queue, cleanup, and health data. Project contents, terminal text, chats, and credentials are not displayed.</p></header><section className="info-section"><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="btn btn-primary" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button><a className="btn btn-ghost" href="/admin/scripts">Manage scripts</a><button className="btn btn-ghost" onClick={() => { setToken(""); setSummary(null); setWorkspaces([]); }}>Lock dashboard</button></div>{error && <p style={{ color: "var(--red)", marginTop: 12 }}>{error}</p>}</section>{summary && pool && host && <>
      <section className="info-section"><h2>Shared server workspace pool</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}><Ring label="Reserved shared capacity" value={pool.reservedBytes} total={pool.maximumBytes} tone="var(--accent)" /><Ring label="Measured active data" value={pool.actualBytes} total={pool.maximumBytes} tone="var(--green)" /><Ring label="Normal new-work admission" value={pool.reservedBytes} total={pool.admissionBytes} tone="var(--yellow)" /></div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 12 }}><MetricCard label="New work available" value={formatBytes(pool.availableAdmissionBytes)} /><MetricCard label="Existing-work extension" value={formatBytes(pool.availableExtensionBytes)} /><MetricCard label="Active reservations" value={String(pool.activeReservations)} /><MetricCard label="Release failures" value={String(pool.releaseFailures)} /></div></section>
      <section className="info-section"><h2>Host pressure and execution queue</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}><Ring label="Host disk used" value={host.disk.usedBytes} total={host.disk.totalBytes} tone="var(--orange)" /><Ring label="Host memory used" value={host.memory.usedBytes} total={host.memory.totalBytes} tone="var(--purple)" /><MetricCard label="Runner queue" value={`${summary.runnerQueue.active} active · ${summary.runnerQueue.queued} waiting`} /><MetricCard label="CPU load" value={`${host.cpu.load1.toFixed(2)} on ${host.cpu.logicalCpus} logical CPUs`} /></div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}><div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Shared-pool reservation history</div><Bars values={history.map((entry) => entry.reservedBytes)} color="var(--accent)" /></div><div style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Host memory history</div><Bars values={history.map((entry) => entry.memoryUsedBytes)} color="var(--purple)" /></div></div></section>
      <section className="info-section"><h2>Cleanup and resource classes</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}><MetricCard label="Active operations" value={String(summary.operational.operations.active)} /><MetricCard label="Expired awaiting cleanup" value={String(summary.operational.operations.expired)} /><MetricCard label="Cleanup failures" value={String(summary.operational.operations.cleanupFailed)} /><MetricCard label="Scheduled workspace cleanup" value={String(summary.workspaces.scheduledDelete)} /></div><div style={{ overflowX: "auto", marginTop: 14 }}><table className="info-table"><thead><tr><th>Resource class</th><th>Reservations</th><th>Reserved</th><th>Measured</th></tr></thead><tbody>{pool.byKind.map((entry) => <tr key={entry.kind}><td>{entry.kind}</td><td>{entry.active}</td><td>{formatBytes(entry.reservedBytes)}</td><td>{formatBytes(entry.actualBytes)}</td></tr>)}</tbody></table></div></section>
      <section className="info-section"><h2>Server workspaces</h2><div style={{ overflowX: "auto" }}><table className="info-table"><thead><tr><th>Workspace</th><th>State</th><th>Last activity</th><th>Expiry</th><th>Quota</th><th>Revision</th><th>Action</th></tr></thead><tbody>{workspaces.map((workspace) => <tr key={workspace.id}><td style={{ fontFamily: "var(--font-code)", fontSize: 11 }}>{workspace.id}</td><td>{workspace.state}</td><td>{formatTime(workspace.lastHeartbeatAt)}</td><td>{formatTime(workspace.expiresAt)}</td><td>{formatBytes(workspace.quotaBytes)}</td><td>{workspace.revision}</td><td>{workspace.state === "active" ? <button className="btn btn-ghost" onClick={() => void scheduleDelete(workspace)}>Schedule four-hour cleanup</button> : "—"}</td></tr>)}</tbody></table></div><p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 12 }}>Last refresh: {formatTime(summary.generatedAt)}. Docker containers monitored: {summary.operational.containers.length}.</p></section>
    </>}</main>;
}
