import { useRef, useEffect, useMemo, useState } from "react";
import { useIDEStore } from "@/store/ideStore";
import { buildPreview } from "@/lib/previewBuilder";
import { execute } from "@/lib/executorChain";
import { isDirectPreviewFile, isPdfPreviewFile } from "@/lib/projectCapabilities";
import { loadBrowserBlob } from "@/lib/browserStorage";
import { getGuiDisplayStatus, stopGuiDisplay } from "@/lib/guiDisplay";
import { getWebProjectPreviewStatus, launchWebProjectPreview, stopWebProjectPreview, type WebPreviewSession } from "@/lib/webPreview";
import { previewFrameKey } from "@/lib/previewFrameKey";
import type { FileNode, PreviewViewport } from "@/types/ide";
type ResultMode = "preview" | "console" | "problems" | "files" | "runtime" | "display";
function previewAssetEntries(nodes: FileNode[]) {
    const entries: { path: string; blobId: string }[] = [];
    const collect = (items: FileNode[]) => items.forEach((node) => {
        if (node.assetBlobId)
            entries.push({ path: node.path, blobId: node.assetBlobId });
        if (node.children)
            collect(node.children);
    });
    collect(nodes);
    return entries;
}
function previewProjectFolder(nodes: FileNode[], activePath?: string) {
    const candidates: FileNode[] = [];
    const collect = (items: FileNode[]) => items.forEach((node) => {
        if (node.type === "folder") {
            const manifest = node.children?.find((child) => child.type === "file" && child.name.toLowerCase() === "package.json");
            if (manifest && /"(?:vite|next)"\s*:/.test(manifest.content || ""))
                candidates.push(node);
            if (node.children)
                collect(node.children);
        }
    });
    collect(nodes);
    return candidates.find((folder) => activePath?.startsWith(`${folder.path}/`)) || candidates[0] || null;
}
export default function PreviewPane() {
    const { fileTree, flatFiles, previewKey, previewPath, settings, updatePreviewSettings, getActiveFile, addTerminalLine, previewResult, setPreviewResult, openFileInTerminal, isRunning, setIsRunning, setFileAssetData, guiDisplay, setGuiDisplay } = useIDEStore();
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const viewportStageRef = useRef<HTMLDivElement>(null);
    const previewFileInputRef = useRef<HTMLInputElement>(null);
    const [externalUrl, setExternalUrl] = useState("");
    const [liveUrl, setLiveUrl] = useState("");
    const [showExternal, setShowExternal] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [resultMode, setResultMode] = useState<ResultMode>("preview");
    const [programInput, setProgramInput] = useState("");
    const [showProgramInput, setShowProgramInput] = useState(false);
    const [runningWithInput, setRunningWithInput] = useState(false);
    const [assetUrl, setAssetUrl] = useState("");
    const [projectAssetUrls, setProjectAssetUrls] = useState<Map<string, string>>(new Map());
    const [previewDocument, setPreviewDocument] = useState("");
    const [viewportStageSize, setViewportStageSize] = useState({ width: 0, height: 0 });
    const [webPreview, setWebPreview] = useState<WebPreviewSession | null>(null);
    const [webPreviewStarting, setWebPreviewStarting] = useState(false);
    const [webPreviewProgress, setWebPreviewProgress] = useState<{ completed: number; total: number } | null>(null);
    const [webPreviewError, setWebPreviewError] = useState("");
    const projectAssetCacheRef = useRef(new Map<string, { blobId: string; url: string }>());
    const viewport = settings.preview.viewport;
    const editorFile = getActiveFile();
    const activeFile = previewPath ? flatFiles.get(previewPath) || editorFile : editorFile;
    const assetPreviewUrl = activeFile?.assetData || assetUrl;
    const isPdfPreview = Boolean(activeFile && isPdfPreviewFile(activeFile));
    const directPreviewNeedsSource = Boolean(activeFile && isDirectPreviewFile(activeFile) && !assetPreviewUrl);
    const projectFolder = useMemo(() => previewProjectFolder(fileTree, activeFile?.path), [fileTree, activeFile?.path]);
    const activePathRef = useRef<string | undefined>(activeFile?.path);
    useEffect(() => {
        if (activePathRef.current !== activeFile?.path) {
            activePathRef.current = activeFile?.path;
            setPreviewResult(null);
            setResultMode("preview");
        }
    }, [activeFile?.path, setPreviewResult]);
    useEffect(() => {
        let objectUrl = "";
        setAssetUrl("");
        if (!activeFile?.assetBlobId)
            return;
        void loadBrowserBlob(activeFile.assetBlobId).then((blob) => {
            if (!blob)
                return;
            objectUrl = URL.createObjectURL(blob);
            setAssetUrl(objectUrl);
        });
        return () => {
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
        };
    }, [activeFile?.assetBlobId]);
    useEffect(() => {
        const stage = viewportStageRef.current;
        if (!stage || resultMode !== "preview")
            return;
        const update = () => setViewportStageSize({ width: stage.clientWidth, height: stage.clientHeight });
        const observer = new ResizeObserver(update);
        observer.observe(stage);
        update();
        return () => observer.disconnect();
    }, [resultMode]);
    const assetEntries = useMemo(() => previewAssetEntries(fileTree), [fileTree]);
    const assetSignature = assetEntries.map((entry) => `${entry.path}:${entry.blobId}`).sort().join("|");
    useEffect(() => {
        let disposed = false;
        const cache = projectAssetCacheRef.current;
        const wanted = new Set(assetEntries.map((entry) => entry.path));
        void Promise.all(assetEntries.map(async (entry) => {
            const cached = cache.get(entry.path);
            if (cached?.blobId === entry.blobId)
                return { ...entry, url: cached.url };
            const blob = await loadBrowserBlob(entry.blobId);
            return { ...entry, url: blob ? URL.createObjectURL(blob) : "" };
        })).then((entries) => {
            if (disposed) {
                entries.forEach((entry) => {
                    const cached = cache.get(entry.path);
                    if (entry.url && cached?.url !== entry.url)
                        URL.revokeObjectURL(entry.url);
                });
                return;
            }
            cache.forEach((entry, path) => {
                const next = entries.find((item) => item.path === path);
                if (!wanted.has(path) || next?.url !== entry.url)
                    URL.revokeObjectURL(entry.url);
            });
            const nextCache = new Map<string, { blobId: string; url: string }>();
            const nextUrls = new Map<string, string>();
            entries.forEach((entry) => {
                if (!entry.url)
                    return;
                nextCache.set(entry.path, { blobId: entry.blobId, url: entry.url });
                nextUrls.set(entry.path, entry.url);
            });
            projectAssetCacheRef.current = nextCache;
            setProjectAssetUrls(nextUrls);
        });
        return () => { disposed = true; };
    }, [assetSignature]);
    useEffect(() => () => {
        projectAssetCacheRef.current.forEach((entry) => URL.revokeObjectURL(entry.url));
        projectAssetCacheRef.current.clear();
    }, []);
    function buildAndSet() {
        if (showExternal)
            return;
        setPreviewDocument(buildPreview(fileTree, activeFile?.path, projectAssetUrls));
        setLoadError(false);
    }
    useEffect(() => {
        if (showExternal)
            return;
        buildAndSet();
    }, [previewKey, fileTree, projectAssetUrls, showExternal, activeFile?.path, resultMode]);
    useEffect(() => {
        setResultMode(guiDisplay?.status === "running" ? "display" : previewResult || isRunning ? "console" : "preview");
    }, [previewResult, isRunning, guiDisplay?.status]);
    useEffect(() => {
        if (!guiDisplay?.id)
            return;
        const refresh = () => void getGuiDisplayStatus(guiDisplay.id).then(setGuiDisplay).catch(() => setGuiDisplay(null));
        const timer = window.setInterval(refresh, 5000);
        return () => window.clearInterval(timer);
    }, [guiDisplay?.id, setGuiDisplay]);
    useEffect(() => {
        if (!webPreview?.id)
            return;
        const refresh = () => void getWebProjectPreviewStatus(webPreview.id).then(setWebPreview).catch((error) => {
            setWebPreview(null);
            setWebPreviewError(error instanceof Error ? error.message : "Project preview is no longer available.");
        });
        const timer = window.setInterval(refresh, 4000);
        return () => window.clearInterval(timer);
    }, [webPreview?.id]);
    useEffect(() => {
        function handle(e: MessageEvent) {
            if (e.data?.type === "console") {
                const level = e.data.level || "log";
                const msg = (e.data.args as string[]).join(" ");
                addTerminalLine({ type: level === "error" ? "error" : "output", content: `[preview] ${msg}` });
            }
            if (e.data?.type === "error") {
                addTerminalLine({ type: "error", content: `[preview] ${e.data.message} (line ${e.data.line})` });
            }
        }
        window.addEventListener("message", handle);
        return () => window.removeEventListener("message", handle);
    }, [addTerminalLine]);
    function handleRefresh() {
        if (showExternal && liveUrl) {
            setLiveUrl("");
            requestAnimationFrame(() => setLiveUrl(externalUrl.trim().startsWith("http") ? externalUrl.trim() : `https://${externalUrl.trim()}`));
        }
        else {
            buildAndSet();
        }
    }
    function handleGoUrl() {
        const url = externalUrl.trim();
        if (!url)
            return;
        const full = url.startsWith("http") ? url : `https://${url}`;
        setLiveUrl(full);
        setShowExternal(true);
        setLoadError(false);
    }
    function handleOpenExternal() {
        if (webPreview?.viewUrl) {
            window.open(webPreview.viewUrl, "_blank");
            return;
        }
        if (showExternal && liveUrl) {
            window.open(liveUrl, "_blank");
            return;
        }
        if (activeFile && isDirectPreviewFile(activeFile) && assetPreviewUrl) {
            window.open(assetPreviewUrl, "_blank");
            return;
        }
        const html = buildPreview(fileTree, activeFile?.path, projectAssetUrls);
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    async function handlePreviewFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !activeFile)
            return;
        const assetData = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the selected file"));
            reader.onerror = () => reject(new Error("Could not read the selected file"));
            reader.readAsDataURL(file);
        }).catch(() => "");
        if (assetData)
            setFileAssetData(activeFile.path, assetData);
    }
    const viewportConfig: Record<PreviewViewport, {
        label: string;
        icon: string;
        width: number;
        height: number;
    }> = {
        mobile: { label: "Mobile", icon: "📱", width: 390, height: 844 },
        tablet: { label: "Tablet", icon: "📟", width: 768, height: 1024 },
        desktop: { label: "Desktop", icon: "🖥", width: 0, height: 0 },
    };
    const cfg = viewportConfig[viewport];
    const localFrameKey = previewFrameKey(viewport, previewKey, activeFile?.path, showExternal, liveUrl);
    const viewportScale = viewport === "desktop"
        ? 1
        : Math.min(1, Math.max(0.1, (viewportStageSize.width - 32) / cfg.width), Math.max(0.1, (viewportStageSize.height - 48) / cfg.height));
    const result = previewResult as (typeof previewResult & {
        tier?: string;
        capability?: string;
        executionTime?: number;
        files?: {
            name: string;
            url?: string;
        }[];
    }) | null;
    const problemLines = result?.stderr?.split("\n").filter((line) => /error|warning|exception|traceback/i.test(line)) ?? [];
    const activeExtension = activeFile?.path.split(".").pop()?.toLowerCase() || activeFile?.language || "";
    const supportsConsoleInput = Boolean(activeFile && !["html", "htm", "css", "md", "json"].includes(activeExtension));
    const resultStatus = isRunning ? "Running" : !result ? "Ready" : result.exitCode === 0 ? "Completed" : "Needs attention";
    const runDetail = !result
        ? showExternal
            ? "Viewing an external web page."
            : "Select a runnable file to see its result."
        : result.tier === "workspace-server"
            ? "This ran in the active workspace. Supported project files and installed dependencies can be used here."
            : result.tier === "public-source"
                ? "This ran in single-file mode. Open Interactive terminal for project files, packages, or live prompts."
                : result.tier === "browser-python"
                    ? "This ran as a local Python source file. Open Interactive terminal for project work or live prompts."
                    : "No compatible runtime is available for this file right now.";
    const modeButtons: {
        id: ResultMode;
        label: string;
    }[] = [
        { id: "preview", label: "Preview" },
        ...(guiDisplay?.status === "running" ? [{ id: "display" as ResultMode, label: "Display" }] : []),
        { id: "console", label: "Console" },
        { id: "problems", label: `Problems${problemLines.length ? ` (${problemLines.length})` : ""}` },
        { id: "files", label: "Files Produced" },
        { id: "runtime", label: "Run details" },
    ];
    async function runWithInput() {
        if (!activeFile || runningWithInput || isRunning)
            return;
        const extension = activeFile.path.split(".").pop()?.toLowerCase() || activeFile.language || "";
        if (["html", "htm", "css", "md", "json"].includes(extension))
            return;
        setRunningWithInput(true);
        setIsRunning(true);
        setPreviewResult(null);
        setResultMode("console");
        try {
            const response = await execute(extension, activeFile.content || "", { stdin: programInput, allowExternalFallback: settings.backend.allowPublicRunner });
            setPreviewResult({
                stdout: response.stdout,
                stderr: response.stderr,
                exitCode: response.exitCode,
                tier: response.tier,
                capability: response.capability,
                executionTime: response.executionTime,
            });
        }
        finally {
            setRunningWithInput(false);
            setIsRunning(false);
        }
    }
    function openInteractiveTerminal() {
        if (!activeFile)
            return;
        openFileInTerminal(activeFile.path, "shell");
    }
    async function stopDisplay() {
        if (!guiDisplay)
            return;
        await stopGuiDisplay(guiDisplay.id).catch(() => undefined);
        setGuiDisplay(null);
        setPreviewResult(null);
        setResultMode("preview");
    }
    async function startWebPreview() {
        if (!projectFolder || webPreviewStarting)
            return;
        setWebPreviewStarting(true);
        setWebPreviewError("");
        setWebPreviewProgress({ completed: 0, total: 0 });
        try {
            const session = await launchWebProjectPreview(projectFolder, fileTree, (completed, total) => setWebPreviewProgress({ completed, total }));
            setWebPreview(session);
            setResultMode("preview");
        }
        catch (error) {
            setWebPreviewError(error instanceof Error ? error.message : "Project preview could not start.");
        }
        finally {
            setWebPreviewStarting(false);
            setWebPreviewProgress(null);
        }
    }
    async function stopWebPreview() {
        if (!webPreview)
            return;
        await stopWebProjectPreview(webPreview.id).catch(() => undefined);
        setWebPreview(null);
        setWebPreviewError("");
    }
    return (<div className="preview-panel">
      <div className="preview-toolbar">
        <div className="preview-mode-group">
          {modeButtons.map((mode) => (<button key={mode.id} className={`preview-viewport-btn ${resultMode === mode.id ? "active" : ""}`} onClick={() => setResultMode(mode.id)} title={mode.label}>
              <span>{mode.label}</span>
            </button>))}
        </div>
        <div className="preview-viewport-group">
          {(["mobile", "tablet", "desktop"] as PreviewViewport[]).map((v) => (<button key={v} className={`preview-viewport-btn ${viewport === v ? "active" : ""}`} onClick={() => updatePreviewSettings({ viewport: v })} title={`${viewportConfig[v].label}${v === "desktop" ? "" : ` (${viewportConfig[v].width} × ${viewportConfig[v].height})`} `}>
              {viewportConfig[v].icon}
              <span>{viewportConfig[v].label}</span>
            </button>))}
        </div>

        <div className="preview-url-bar">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
          <input value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="Enter URL to preview..." onKeyDown={(e) => e.key === "Enter" && handleGoUrl()}/>
        </div>

        <button className="btn btn-secondary" onClick={handleGoUrl} style={{ padding: "0.2rem 0.55rem", fontSize: 11, flexShrink: 0 }}>
          Go
        </button>

        {projectFolder && !webPreview && <button className="btn btn-secondary" onClick={() => void startWebPreview()} disabled={webPreviewStarting} style={{ padding: "0.2rem 0.55rem", fontSize: 11, flexShrink: 0 }}>
          {webPreviewStarting ? "Starting…" : "Start project"}
        </button>}

        {webPreview && <button className="btn btn-ghost" onClick={() => void stopWebPreview()} style={{ padding: "0.2rem 0.55rem", fontSize: 11, flexShrink: 0 }}>
          Stop project
        </button>}

        {showExternal && (<button className="btn btn-ghost" onClick={() => { setShowExternal(false); setLiveUrl(""); buildAndSet(); }} style={{ fontSize: 11, padding: "0.2rem 0.4rem", flexShrink: 0 }}>
            ✕ Local
          </button>)}

        <button className="btn-icon" onClick={handleRefresh} title="Refresh">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>

        <button className="btn-icon" onClick={handleOpenExternal} title="Open in new tab">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>
      </div>

      <div className="preview-content-area">
        {webPreview?.viewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.55rem 0.75rem", borderBottom: "1px solid #30363d", color: "#c9d1d9", fontSize: 12 }}>
              <span>{webPreview.kind === "next" ? "Next.js" : "Vite"} project preview · isolated short session</span>
              <button className="btn btn-ghost" onClick={() => void stopWebPreview()} style={{ fontSize: 11, padding: "0.25rem 0.45rem" }}>Stop project</button>
            </div>
            <iframe title="Isolated project preview" src={webPreview.viewUrl} sandbox="allow-scripts allow-forms allow-popups" style={{ width: "100%", height: "100%", border: "none", background: "#111" }}/>
          </div>) : webPreviewStarting || webPreviewError ? (<div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "#0d1117", padding: "1rem", boxSizing: "border-box" }}>
            <div style={{ width: "min(460px, 100%)", display: "grid", gap: "0.75rem", textAlign: "center", padding: "1.25rem", border: "1px solid #30363d", borderRadius: 12, background: "#161b22" }}>
              <strong style={{ color: "#e6edf3" }}>{webPreviewStarting ? "Preparing isolated project preview" : "Project preview could not start"}</strong>
              <span style={{ color: webPreviewError ? "#f97583" : "#8b949e", fontSize: 12, lineHeight: 1.55 }}>{webPreviewError || (webPreviewProgress?.total ? `Staging ${Math.min(100, Math.round((webPreviewProgress.completed / webPreviewProgress.total) * 100))}% of this browser project.` : "Creating a temporary isolated workspace.")}</span>
              {webPreviewError && projectFolder && <button className="btn btn-secondary" onClick={() => void startWebPreview()}>Try again</button>}
            </div>
          </div>) : resultMode === "display" && guiDisplay?.viewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.55rem 0.75rem", borderBottom: "1px solid #30363d", color: "#c9d1d9", fontSize: 12 }}>
              <span>Interactive display session. It closes automatically when its short session expires.</span>
              <button className="btn btn-ghost" onClick={() => void stopDisplay()} style={{ fontSize: 11, padding: "0.25rem 0.45rem" }}>Stop display</button>
            </div>
            <iframe title="Interactive graphical display" src={guiDisplay.viewUrl} sandbox="allow-scripts allow-forms allow-popups" style={{ width: "100%", height: "100%", border: "none", background: "#111" }}/>
          </div>) : resultMode === "preview" && directPreviewNeedsSource ? (<div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "#0d1117", padding: "1rem", boxSizing: "border-box" }}>
            <div style={{ width: "min(440px, 100%)", display: "grid", gap: "0.75rem", textAlign: "center", padding: "1.25rem", border: "1px solid #30363d", borderRadius: 12, background: "#161b22" }}>
              <strong style={{ color: "#e6edf3" }}>Choose the original file to preview {activeFile?.name}</strong>
              <span style={{ color: "#8b949e", fontSize: 12, lineHeight: 1.55 }}>This saved workspace entry does not include its binary data yet. Choosing the original file restores a local preview and keeps it with this workspace.</span>
              <input ref={previewFileInputRef} type="file" accept="image/*,audio/*,video/*,application/pdf,.pdf" hidden onChange={(event) => void handlePreviewFileSelect(event)}/>
              <button className="btn btn-primary" onClick={() => previewFileInputRef.current?.click()}>Choose original file</button>
            </div>
          </div>) : resultMode === "console" ? (<div className="result-console">
            <div className="result-summary-header">
              <div>
                <span className="result-summary-label">Result</span>
                <strong>{activeFile?.name || "No file selected"}</strong>
              </div>
              <span className={`result-status ${isRunning ? "neutral" : result?.exitCode === 0 ? "success" : result ? "error" : "neutral"}`}>{resultStatus}</span>
            </div>
            {isRunning && (<div className="result-run-progress" role="status" aria-live="polite">
                <span className="result-run-spinner"/>
                <span>Running {activeFile?.name || "the selected file"}…</span>
                <span className="result-run-progress-bar"><span /></span>
              </div>)}
            {supportsConsoleInput && (<div className="result-action-row">
                <button className={`btn btn-ghost ${showProgramInput ? "active" : ""}`} onClick={() => setShowProgramInput((visible) => !visible)} disabled={isRunning} title={isRunning ? "Wait for the current run to finish" : undefined}>
                  {showProgramInput ? "Hide program input" : "Program input"}
                </button>
                <button className="btn btn-secondary" onClick={openInteractiveTerminal} disabled={isRunning}>
                  Open interactive terminal
                </button>
              </div>)}
            {supportsConsoleInput && showProgramInput && (<div className="program-input-card">
                <div>
                  <strong>Program input</strong>
                  <span>Add values your program should read, one value per line.</span>
                </div>
                <textarea value={programInput} onChange={(event) => setProgramInput(event.target.value)} placeholder={"Example:\n10\n20"} spellCheck={false}/>
                <button className="btn btn-secondary" onClick={() => void runWithInput()} disabled={runningWithInput || isRunning}>
                  {isRunning || runningWithInput ? "Waiting for current run…" : "Run with these values"}
                </button>
              </div>)}
            {result?.stdout && (<pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#e6edf3" }}>{result.stdout}</pre>)}
            {result?.stderr && (<pre style={{ margin: result.stdout ? "0.75rem 0 0" : 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#f97583" }}>{result.stderr}</pre>)}
            {!result?.stdout && !result?.stderr && (<span style={{ color: "#8b949e" }}>{isRunning ? "The result will appear here when execution finishes." : "Select a runnable file to see its result here."}</span>)}
            <div style={{ marginTop: "0.75rem", color: result?.exitCode === 0 ? "#56d364" : "#f97583", fontSize: 11, borderTop: "1px solid #21262d", paddingTop: "0.5rem" }}>
              exit code: {isRunning ? "running" : result?.exitCode ?? "—"}
            </div>
          </div>) : resultMode === "problems" ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", padding: "1rem", overflowY: "auto", boxSizing: "border-box" }}>
            {problemLines.length ? problemLines.map((line, index) => <div key={`${line}-${index}`} style={{ color: /warning/i.test(line) ? "#e3b341" : "#f97583", fontFamily: "var(--font-mono)", fontSize: 12, padding: "0.35rem 0", borderBottom: "1px solid #21262d", whiteSpace: "pre-wrap" }}>{line}</div>) : <span style={{ color: "#8b949e", fontSize: 13 }}>No compiler or runtime problems were reported.</span>}
          </div>) : resultMode === "files" ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", padding: "1rem", overflowY: "auto", boxSizing: "border-box" }}>
            {result?.files?.length ? result.files.map((file) => <div key={file.name} style={{ display: "flex", justifyContent: "space-between", padding: "0.45rem 0", borderBottom: "1px solid #21262d", color: "#e6edf3", fontFamily: "var(--font-mono)", fontSize: 12 }}><span>{file.name}</span>{file.url ? <a href={file.url} download={file.name} style={{ color: "var(--accent)" }}>Download</a> : <span style={{ color: "#8b949e" }}>Available in workspace</span>}</div>) : <span style={{ color: "#8b949e", fontSize: 13 }}>Generated files and build artifacts appear here after a workspace command produces them.</span>}
          </div>) : resultMode === "runtime" ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", padding: "1rem", overflowY: "auto", boxSizing: "border-box", color: "#e6edf3" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: "0.8rem" }}>Run details</div>
            <div style={{ fontFamily: "var(--font-mono)", color: result?.exitCode === 0 ? "#56d364" : result ? "#f97583" : "#58a6ff", fontSize: 12 }}>{resultStatus}</div>
            <div style={{ color: "#8b949e", fontSize: 12, marginTop: "0.75rem", lineHeight: 1.6 }}>{runDetail}</div>
            {result?.executionTime !== undefined && <div style={{ color: "#8b949e", fontSize: 12, marginTop: "0.75rem" }}>Finished in {result.executionTime} ms</div>}
          </div>) : isPdfPreview && assetPreviewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117" }}>
            <iframe title={`${activeFile?.name || "PDF"} PDF preview`} src={assetPreviewUrl} style={{ width: "100%", height: "100%", border: "none", display: "block", background: "white" }}/>
          </div>) : activeFile?.assetMimeType?.startsWith("image/") && assetPreviewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", display: "grid", placeItems: "center", overflow: "auto" }}>
            <img src={assetPreviewUrl} alt={activeFile.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}/>
          </div>) : activeFile?.assetMimeType?.startsWith("video/") && assetPreviewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", display: "grid", placeItems: "center" }}>
            <video src={assetPreviewUrl} controls style={{ maxWidth: "100%", maxHeight: "100%" }}/>
          </div>) : activeFile?.assetMimeType?.startsWith("audio/") && assetPreviewUrl ? (<div style={{ width: "100%", height: "100%", background: "#0d1117", display: "grid", placeItems: "center", padding: "2rem" }}>
            <audio src={assetPreviewUrl} controls style={{ width: "min(640px, 100%)" }}/>
          </div>) : (<div className="preview-viewport-stage" ref={viewportStageRef}>
            {viewport === "desktop" ? <iframe key={localFrameKey} ref={iframeRef} title="Preview" src={showExternal ? liveUrl : undefined} srcDoc={showExternal ? undefined : previewDocument} sandbox="allow-scripts allow-modals allow-forms allow-popups" allow="camera; microphone" className="preview-viewport-desktop" onError={() => setLoadError(true)}/> : <>
                <div className="preview-viewport-scale-box" style={{ width: cfg.width * viewportScale, height: cfg.height * viewportScale }}>
                  <iframe key={localFrameKey} ref={iframeRef} title="Preview" src={showExternal ? liveUrl : undefined} srcDoc={showExternal ? undefined : previewDocument} sandbox="allow-scripts allow-modals allow-forms allow-popups" allow="camera; microphone" className="preview-viewport-native" style={{ width: cfg.width, height: cfg.height, transform: `scale(${viewportScale})` }} onError={() => setLoadError(true)}/>
                </div>
                <div className="preview-viewport-label">{cfg.icon} {cfg.label} — {cfg.width} × {cfg.height}</div>
              </>}
          </div>)}

        {loadError && (<div className="preview-error-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            This URL blocks embedding. <button onClick={handleOpenExternal} style={{ color: "var(--accent)", textDecoration: "underline", background: "none", cursor: "pointer" }}>Open in browser tab</button>
          </div>)}
      </div>
    </div>);
}
