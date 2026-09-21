import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { useIDEStore } from "@/store/ideStore";
import { getQueueStatus } from "@/lib/operationQueue";
import TopBar from "@/components/ide/TopBar";
import BottomNav from "@/components/ide/BottomNav";
import FileExplorer from "@/components/ide/FileExplorer";
import EditorTabs from "@/components/ide/EditorTabs";
import PreviewPane from "@/components/ide/PreviewPane";
import SettingsPanel from "@/components/ide/SettingsPanel";
import ContextMenu from "@/components/ide/ContextMenu";
import NewFileDialog from "@/components/ide/NewFileDialog";
import ErrorPanel from "@/components/ide/ErrorPanel";
import CodeEditor from "@/components/ide/CodeEditor";
const loadAIChatPanel = () => import("@/components/ide/AIChatPanel");
const loadCloudShell = () => import("@/components/ide/CloudShell");
const loadApkEditor = () => import("@/components/ide/ApkEditor");
const loadTerminal = () => import("@/components/ide/Terminal");
const AIChatPanel = lazy(loadAIChatPanel);
const CloudShell = lazy(loadCloudShell);
const ApkEditor = lazy(loadApkEditor);
const Terminal = lazy(loadTerminal);
function PanelLoading() {
    return <div className="panel-skeleton" aria-label="Loading workspace panel"><span/><span/><span/></div>;
}
function TransferStatusNotice() {
    const transferStatus = useIDEStore((state) => state.transferStatus);
    if (!transferStatus)
        return null;
    return <div aria-live="polite" style={{ position: "fixed", zIndex: 75, left: "50%", bottom: 58, transform: "translateX(-50%)", width: "min(440px, calc(100vw - 28px))", padding: "0.55rem 0.65rem", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-elevated)", boxShadow: "0 10px 30px rgba(0,0,0,0.28)", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11 }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{transferStatus.kind === "import" ? "Importing" : transferStatus.kind === "export" ? "Exporting" : transferStatus.stage}{transferStatus.current ? ` · ${transferStatus.current}` : ""}</span><strong style={{ flexShrink: 0, color: "var(--text-primary)" }}>{transferStatus.total ? `${Math.round((transferStatus.completed / transferStatus.total) * 100)}%` : "Working"}</strong></div>
      <div className="skeleton" style={{ height: 6, overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: transferStatus.total ? `${Math.round((transferStatus.completed / transferStatus.total) * 100)}%` : "18%", background: "var(--accent)", transition: "width 160ms ease" }}/></div>
    </div>;
}
export default function IndexPage() {
    const activePanel = useIDEStore((state) => state.activePanel);
    const sidebarOpen = useIDEStore((state) => state.sidebarOpen);
    const showSettings = useIDEStore((state) => state.showSettings);
    const setContextMenu = useIDEStore((state) => state.setContextMenu);
    const newItemType = useIDEStore((state) => state.newItemType);
    const queueStatus = getQueueStatus();
    const combinedWorkspace = activePanel === "editor" && sidebarOpen;
    useEffect(() => {
        const preload = () => {
            void loadAIChatPanel();
            void loadCloudShell();
            void loadApkEditor();
            void loadTerminal();
        };
        const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
        if (idleWindow.requestIdleCallback) {
            const handle = idleWindow.requestIdleCallback(preload, { timeout: 1500 });
            return () => idleWindow.cancelIdleCallback?.(handle);
        }
        const timer = window.setTimeout(preload, 700);
        return () => window.clearTimeout(timer);
    }, []);
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport)
            return;
        let frame = 0;
        const syncKeyboardInset = () => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
                document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
            });
        };
        syncKeyboardInset();
        viewport.addEventListener("resize", syncKeyboardInset);
        viewport.addEventListener("scroll", syncKeyboardInset);
        return () => {
            window.cancelAnimationFrame(frame);
            viewport.removeEventListener("resize", syncKeyboardInset);
            viewport.removeEventListener("scroll", syncKeyboardInset);
            document.documentElement.style.removeProperty("--keyboard-inset");
        };
    }, []);
    return (<div className="ide-layout" onClick={() => setContextMenu(null)}>
      <TopBar />

      <div className={`ide-main${combinedWorkspace ? " workspace-combined" : ""}`}>
        {activePanel !== "files" && <div className={`ide-sidebar${combinedWorkspace ? " sidebar-open" : ""}`}>
          <FileExplorer />
        </div>}

        <div className="ide-center">
          {activePanel === "files" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <FileExplorer />
            </div>)}
          {activePanel === "editor" && <div className="ide-editor-area" style={{ position: "relative" }}>
            <EditorTabs />
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <CodeEditor />
            </div>
            <ErrorPanel />
          </div>}
          {activePanel === "preview" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <PreviewPane />
            </div>)}
          {activePanel === "ai" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Suspense fallback={<PanelLoading />}><AIChatPanel /></Suspense>
            </div>)}
          {activePanel === "terminal" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Suspense fallback={<PanelLoading />}><Terminal /></Suspense>
            </div>)}
          {activePanel === "cloud" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Suspense fallback={<PanelLoading />}><CloudShell /></Suspense>
            </div>)}
          {activePanel === "apk" && (<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Suspense fallback={<PanelLoading />}><ApkEditor /></Suspense>
            </div>)}
        </div>
      </div>

      <TransferStatusNotice />

      {queueStatus.waiting && (<div style={{ position: "fixed", top: 58, left: "50%", transform: "translateX(-50%)", zIndex: 40, width: "min(560px, calc(100vw - 24px))", padding: "0.6rem 0.9rem", borderRadius: 10, border: "1px solid rgba(250, 204, 21, 0.38)", background: "rgba(24, 18, 2, 0.9)", color: "#fef3c7", boxShadow: "0 16px 32px rgba(0,0,0,0.28)", fontSize: 12, fontWeight: 600, letterSpacing: 0.1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }} aria-live="polite">
        <span>{queueStatus.message}</span>
        <span style={{ flexShrink: 0, borderRadius: 999, background: "rgba(250, 204, 21, 0.12)", color: "#fcd34d", padding: "0.2rem 0.45rem", fontSize: 10, fontWeight: 700 }}>Queued</span>
      </div>)}

      <BottomNav />

      {showSettings && <SettingsPanel />}
      {newItemType && <NewFileDialog />}
      <ContextMenu />

      <Toaster position="top-right" theme="dark" closeButton toastOptions={{
            style: {
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
            },
        }}/>
    </div>);
}
