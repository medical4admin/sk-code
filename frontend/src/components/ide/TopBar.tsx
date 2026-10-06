import { useIDEStore } from "@/store/ideStore";
import logoIcon from "@/assets/logo-icon.png";
import { buildPreview } from "@/lib/previewBuilder";
import { unifiedExecute, getFileExtension } from "@/lib/unifiedExecutor";
import { getFileCapability } from "@/lib/projectCapabilities";
import { supportsGuiDisplay } from "@/lib/projectCapabilities";
import { launchGuiDisplay, stopGuiDisplay } from "@/lib/guiDisplay";
import { releasePreviousGuiSession } from "@/lib/guiSessionReplacement";
import { toast } from "sonner";
import { parseErrors } from "@/components/ide/ErrorPanel";
export default function TopBar() {
    const { isRunning, setIsRunning, fileTree, activePanel, sidebarOpen, setActivePanel, setShowSettings, getActiveFile, setPreviewContent, setPreviewPath, setErrors, setPreviewResult, setGuiDisplay, guiDisplay, settings } = useIDEStore();
    const activeFile = getActiveFile();
    const fileCapability = activeFile ? getFileCapability(activeFile) : "none";
    const showRunControl = activePanel === "editor" && Boolean(activeFile) && fileCapability !== "none";
    const showDisplayControl = activePanel === "editor" && Boolean(activeFile && supportsGuiDisplay(activeFile));
    async function handleRun() {
        if (isRunning) {
            setIsRunning(false);
            return;
        }
        if (!activeFile || fileCapability === "none") {
            toast.error("Open a runnable file in Editor first");
            return;
        }
        const ext = getFileExtension(activeFile.name);
        const code = activeFile.content || "";
        if (fileCapability === "preview") {
            setPreviewResult(null);
            setPreviewPath(activeFile.path);
            setPreviewContent(buildPreview(fileTree, activeFile.path));
            setActivePanel("preview");
            return;
        }
        setActivePanel("preview");
        setPreviewPath(activeFile.path);
        setErrors([]);
        setIsRunning(true);
        setPreviewResult(null);
        try {
            const result = await unifiedExecute(ext, code, { allowExternalFallback: settings.backend.allowPublicRunner });
            if (!result) {
                setPreviewResult({
                    stdout: "",
                    stderr: `No execution route is available for .${ext} in this environment.`,
                    exitCode: null,
                    tier: "unavailable",
                    capability: "No compatible runtime is currently available.",
                });
                return;
            }
            if (result.stderr) {
                const errors = parseErrors(result.stderr, activeFile.name);
                if (errors.length)
                    setErrors(errors);
            }
            setPreviewResult({
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                tier: result.executor,
                capability: result.capability,
                executionTime: result.executionTime,
            });
        }
        finally {
            setIsRunning(false);
        }
    }
    async function handleRunWithDisplay() {
        if (!activeFile || isRunning)
            return;
        setActivePanel("preview");
        setPreviewPath(activeFile.path);
        setPreviewResult(null);
        await releasePreviousGuiSession(guiDisplay?.id, stopGuiDisplay);
        setGuiDisplay(null);
        setIsRunning(true);
        const notification = toast.loading(`Preparing graphical display for ${activeFile.name}…`);
        try {
            const session = await launchGuiDisplay(activeFile, fileTree, (completed, total) => {
                if (total > 0)
                    toast.loading(`Preparing graphical display: ${Math.min(100, Math.round(completed / total * 100))}%`, { id: notification });
            });
            setGuiDisplay(session);
            setPreviewResult({
                stdout: "",
                stderr: "",
                exitCode: 0,
                tier: "gui-display",
                capability: "Running in an isolated graphical display session.",
            });
            toast.success("Graphical display is ready", { id: notification });
        }
        catch (error) {
            setPreviewResult({
                stdout: "",
                stderr: error instanceof Error ? error.message : "Unable to start graphical display.",
                exitCode: 1,
                tier: "gui-display",
                capability: "Graphical display did not start.",
            });
            toast.error("Graphical display could not start", { id: notification });
        }
        finally {
            setIsRunning(false);
        }
    }
    const runLabel = fileCapability === "preview" ? "Preview" : "Run";
    return (<div className="ide-topbar">
      <div className="topbar-logo">
        <img className="topbar-logo-image" src={logoIcon} alt="SK Coder logo"/>
        <div className="topbar-brand-stack"><span>SK Coder</span></div>
      </div>

      {activeFile && <><div className="topbar-divider"/><span className="topbar-breadcrumb">{activeFile.name}</span></>}

      <div className="topbar-actions">
        <button className="btn btn-ghost" onClick={() => { window.location.href = "/guide"; }} title="Open the complete User Manual" style={{ fontSize: 11, padding: "0.3rem 0.5rem" }}>
          Manual
        </button>
        {showRunControl && (<button className={`topbar-run-btn${isRunning ? " running" : ""}`} onClick={handleRun} title={isRunning ? "Stop execution" : `${runLabel} ${activeFile?.name}`}>
            {isRunning ? <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="3" height="8" rx="1"/><rect x="7" y="2" width="3" height="8" rx="1"/></svg> : <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,1 11,6 2,11"/></svg>}
            {isRunning ? "Stop" : runLabel}
          </button>)}
        {showDisplayControl && (<button className="btn btn-secondary" onClick={() => void handleRunWithDisplay()} disabled={isRunning} title={`Run ${activeFile?.name} in an isolated graphical display`} style={{ fontSize: 11, padding: "0.32rem 0.52rem" }}>
            Run with Display
          </button>)}
        <button className="btn-icon" onClick={() => setShowSettings(true)} title="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>);
}
