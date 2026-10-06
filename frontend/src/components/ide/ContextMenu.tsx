import { useEffect, useRef, useState } from "react";
import { useIDEStore } from "@/store/ideStore";
import { exportToZip, downloadBlob, importFromArchive, isArchiveCandidate, isZipCompatibleArchive } from "@/lib/importProject";
import { loadBrowserBlob } from "@/lib/browserStorage";
import { buildPreview } from "@/lib/previewBuilder";
import { getFileCapability, isDirectPreviewFile, previewLabelFor, supportsGuiDisplay } from "@/lib/projectCapabilities";
import { execute } from "@/lib/executorChain";
import { launchGuiDisplay, stopGuiDisplay } from "@/lib/guiDisplay";
import { releasePreviousGuiSession } from "@/lib/guiSessionReplacement";
import type { FileNode } from "@/types/ide";
import { toast } from "sonner";
function findNodeInTree(nodes: FileNode[], path: string): FileNode | null {
    for (const node of nodes) {
        if (node.path === path)
            return node;
        if (node.children) {
            const found = findNodeInTree(node.children, path);
            if (found)
                return found;
        }
    }
    return null;
}
function insertNodeIntoTree(nodes: FileNode[], parentPath: string, newNode: FileNode): FileNode[] {
    if (parentPath === "/" || parentPath === "") {
        return [...nodes, newNode];
    }
    return nodes.map((node) => {
        if (node.path === parentPath && node.type === "folder") {
            return { ...node, children: [...(node.children || []), newNode] };
        }
        if (node.children) {
            return { ...node, children: insertNodeIntoTree(node.children, parentPath, newNode) };
        }
        return node;
    });
}
function cloneNodeTree(node: FileNode, newPath: string): FileNode {
    const cloned: FileNode = {
        ...node,
        id: `${node.id}-copy-${Math.random().toString(36).slice(2, 8)}`,
        path: newPath,
        content: node.type === "file" ? node.content : undefined,
        children: undefined,
    };
    if (node.type === "folder" && node.children) {
        cloned.children = node.children.map((child) => cloneNodeTree(child, `${newPath}/${child.name}`));
    }
    return cloned;
}
function makeUniquePath(nodes: FileNode[], basePath: string): string {
    let candidate = basePath;
    let counter = 2;
    while (findNodeInTree(nodes, candidate)) {
        candidate = `${basePath}-copy-${counter}`;
        counter += 1;
    }
    return candidate;
}
export default function ContextMenu() {
    const { contextMenu, setContextMenu, deleteNode, setRenameNodeId, setNewItem, openTab, fileTree, setActivePanel, addTerminalLine, setTerminalInput, refreshPreview, setPreviewContent, clearTerminal, getActiveFile, settings, openInTerminal, openFileInTerminal, setFileTree, toggleFolder, moveNode, setSidebarOpen, setPreviewResult, setSelectionMode, toggleSelectedPath, setIsRunning, setPreviewPath, setGuiDisplay, guiDisplay, } = useIDEStore();
    const ref = useRef<HTMLDivElement>(null);
    const [clipboardState, setClipboardState] = useState<{
        path: string;
        mode: "copy" | "move";
    } | null>(null);
    const [termSubMenu, setTermSubMenu] = useState(false);
    const TERM_OPTS = [
        { type: "shell", label: "SK Shell", color: "#10b981" },
        { type: "ai", label: "AI Terminal", color: "#a78bfa" },
    ] as const;
    useEffect(() => {
        function handle(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node))
                setContextMenu(null);
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [setContextMenu]);
    useEffect(() => {
        try {
            const stored = localStorage.getItem("sk-coder-context-clipboard");
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed?.path && (parsed.mode === "copy" || parsed.mode === "move")) {
                    setClipboardState(parsed);
                }
            }
        }
        catch {
        }
    }, []);
    useEffect(() => {
        if (clipboardState) {
            localStorage.setItem("sk-coder-context-clipboard", JSON.stringify(clipboardState));
        }
        else {
            localStorage.removeItem("sk-coder-context-clipboard");
        }
    }, [clipboardState]);
    if (!contextMenu)
        return null;
    const { x, y, node, isFolder } = contextMenu;
    const fileCapability = node?.type === "file" ? getFileCapability(node) : "none";
    const guiDisplaySupported = Boolean(node?.type === "file" && supportsGuiDisplay(node));
    const canExtract = Boolean(node?.type === "file" && (isArchiveCandidate(node.name) || node.assetMimeType === "application/zip"));
    async function handleExport() {
        if (!node)
            return;
        if (node.type === "file") {
            const blob = new Blob([node.content || ""], { type: "text/plain" });
            downloadBlob(blob, node.name);
            toast.success(`Downloaded ${node.name}`);
        }
        else {
            const blob = await exportToZip([node]);
            downloadBlob(blob, node.name + ".zip");
            toast.success(`Exported ${node.name}.zip`);
        }
        setContextMenu(null);
    }
    async function handleExtract() {
        if (!node || node.type !== "file") return;
        if (!isZipCompatibleArchive(node.name) && node.assetMimeType !== "application/zip") {
            toast.error("This archive format is recognized, but browser extraction currently supports ZIP-compatible archives. Use a connected workspace backend for this format.");
            setContextMenu(null);
            return;
        }
        try {
            const blob = node.assetBlobId ? await loadBrowserBlob(node.assetBlobId) : new Blob([node.content || ""], { type: "application/zip" });
            if (!blob) throw new Error("This archive is no longer available in browser storage. Import it again before extraction.");
            const imported = await importFromArchive(new File([blob], node.name, { type: "application/zip" }));
            const root = imported[0];
            if (!root) throw new Error("This archive did not contain importable entries.");
            const parentPath = node.path.substring(0, node.path.lastIndexOf("/")) || "/";
            const targetPath = makeUniquePath(fileTree, `${parentPath === "/" ? "" : parentPath}/${root.name}` || `/${root.name}`);
            setFileTree(insertNodeIntoTree(fileTree, parentPath, cloneNodeTree(root, targetPath)));
            toggleFolder(targetPath);
            toast.success(`Extracted ${node.name} into ${targetPath}`);
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not extract this archive.");
        }
        setContextMenu(null);
    }
    function handleCopyPath() {
        if (!node)
            return;
        navigator.clipboard.writeText(node.path);
        toast.success("Path copied");
        setContextMenu(null);
    }
    function handleCopyContent() {
        if (!node || node.type !== "file")
            return;
        navigator.clipboard.writeText(node.content || "");
        toast.success("Content copied");
        setContextMenu(null);
    }
    function handleCopyNode() {
        if (!node)
            return;
        setClipboardState({ path: node.path, mode: "copy" });
        toast.success(`Copied ${node.name}`);
        setContextMenu(null);
    }
    function handleMoveNode() {
        if (!node)
            return;
        setClipboardState({ path: node.path, mode: "move" });
        toast.success(`Move ready: ${node.name}`);
        setContextMenu(null);
    }
    function handleSelectNode() {
        if (!node)
            return;
        setSelectionMode(true);
        toggleSelectedPath(node.path);
        setContextMenu(null);
        toast.info("Selection mode enabled");
    }
    function handlePasteHere() {
        if (!node || node.type !== "folder" || !clipboardState)
            return;
        const source = findNodeInTree(fileTree, clipboardState.path);
        if (!source) {
            toast.error("Source item no longer exists");
            setClipboardState(null);
            setContextMenu(null);
            return;
        }
        if (source.path === node.path) {
            toast.error("Cannot paste into itself");
            setContextMenu(null);
            return;
        }
        if (source.type === "folder" && node.path.startsWith(source.path + "/")) {
            toast.error("Cannot paste folder into its own child");
            setContextMenu(null);
            return;
        }
        if (clipboardState.mode === "move") {
            moveNode(source.path, node.path);
            toast.success(`Moved ${source.name}`);
        }
        else {
            const targetPath = makeUniquePath(fileTree, `${node.path}/${source.name}`);
            const copied = cloneNodeTree(source, targetPath);
            const nextTree = insertNodeIntoTree(fileTree, node.path, copied);
            setFileTree(nextTree);
            toast.success(`Copied ${source.name}`);
        }
        setClipboardState(null);
        setContextMenu(null);
    }
    function handleDelete() {
        if (!node)
            return;
        if (confirm(`Delete "${node.name}"?`)) {
            deleteNode(node.path);
            toast.success(`Deleted ${node.name}`);
        }
        setContextMenu(null);
    }
    function handleRename() {
        if (!node)
            return;
        setRenameNodeId(node.id);
        setContextMenu(null);
    }
    function handleNewFile() {
        setNewItem(isFolder ? node!.id : null, "file");
        setContextMenu(null);
    }
    function handleNewFolder() {
        setNewItem(isFolder ? node!.id : null, "folder");
        setContextMenu(null);
    }
    function handleOpen() {
        if (!node || node.type !== "file")
            return;
        if (isDirectPreviewFile(node)) {
            setPreviewResult(null);
            setIsRunning(false);
            setPreviewPath(node.path);
            setPreviewContent(buildPreview(fileTree, node.path));
            refreshPreview();
            setActivePanel("preview");
        }
        else {
            openTab(node);
            setActivePanel("editor");
            setSidebarOpen(false);
        }
        setContextMenu(null);
    }
    function handlePreviewFile() {
        if (!node || node.type !== "file")
            return;
        setPreviewResult(null);
        setIsRunning(false);
        setPreviewPath(node.path);
        setPreviewContent(buildPreview(fileTree, node.path));
        refreshPreview();
        setActivePanel("preview");
        setContextMenu(null);
    }
    async function handleRunFile() {
        if (!node || node.type !== "file")
            return;
        const extension = node.name.split(".").pop()?.toLowerCase() || "";
        setActivePanel("preview");
        setContextMenu(null);
        setPreviewPath(node.path);
        setPreviewResult(null);
        setIsRunning(true);
        try {
            const result = await execute(extension, node.content || "", { allowExternalFallback: settings.backend.allowPublicRunner });
            setPreviewResult({
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                tier: result.tier,
                capability: result.capability,
                executionTime: result.executionTime,
            });
            if (result.exitCode === 0)
                toast.success(`Finished ${node.name}`);
            else
                toast.error(`Finished with errors: ${node.name}`);
        }
        finally {
            setIsRunning(false);
        }
    }
    async function handleRunWithDisplay() {
        if (!node || node.type !== "file")
            return;
        setContextMenu(null);
        setActivePanel("preview");
        setPreviewPath(node.path);
        setPreviewResult(null);
        await releasePreviousGuiSession(guiDisplay?.id, stopGuiDisplay);
        setGuiDisplay(null);
        setIsRunning(true);
        const notification = toast.loading(`Preparing graphical display for ${node.name}…`);
        try {
            const session = await launchGuiDisplay(node, fileTree, (completed, total) => {
                if (total > 0)
                    toast.loading(`Preparing graphical display: ${Math.min(100, Math.round(completed / total * 100))}%`, { id: notification });
            });
            setGuiDisplay(session);
            setPreviewResult({ stdout: "", stderr: "", exitCode: 0, tier: "gui-display", capability: "Running in an isolated graphical display session." });
            toast.success("Graphical display is ready", { id: notification });
        }
        catch (error) {
            setPreviewResult({ stdout: "", stderr: error instanceof Error ? error.message : "Unable to start graphical display.", exitCode: 1, tier: "gui-display", capability: "Graphical display did not start." });
            toast.error("Graphical display could not start", { id: notification });
        }
        finally {
            setIsRunning(false);
        }
    }
    function handleOpenInTerminal(termType?: string) {
        if (!node)
            return;
        openInTerminal(node.path, node.type === "folder", termType);
        setContextMenu(null);
        const dir = node.type === "folder" ? node.path : (node.path.substring(0, node.path.lastIndexOf("/")) || "/");
        toast.success(`Opened in ${termType ?? "shell"} terminal → ${dir}`);
    }
    function handleOpenCodespace() {
        setActivePanel("cloud");
        setContextMenu(null);
        toast.info("Go to GitHub panel to open in Codespace");
    }
    const MENU_WIDTH = 200;
    const MENU_HEIGHT = 380;
    const SUBMENU_WIDTH = 180;
    let menuLeft = x;
    let menuTop = y;
    if (x + MENU_WIDTH > window.innerWidth - 10) {
        menuLeft = window.innerWidth - MENU_WIDTH - 10;
    }
    if (y + MENU_HEIGHT > window.innerHeight - 10) {
        menuTop = window.innerHeight - MENU_HEIGHT - 10;
    }
    const submenuLeft = menuLeft + MENU_WIDTH + 8 > window.innerWidth - SUBMENU_WIDTH ? "auto" : "100%";
    const submenuRight = submenuLeft === "auto" ? "100%" : "auto";
    return (<div className="context-menu" ref={ref} style={{ left: menuLeft, top: menuTop }}>
      {node?.type === "file" && (<div className="context-menu-item" onClick={handleOpen}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          {"Open in Editor"}
        </div>)}

      {canExtract && <div className="context-menu-item" onClick={() => void handleExtract()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
          Extract archive
        </div>}


      <div className="context-menu-item context-submenu-trigger" onMouseEnter={() => setTermSubMenu(true)} onMouseLeave={() => setTermSubMenu(false)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        Open in Terminal
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: "auto" }}><polyline points="9 18 15 12 9 6"/></svg>
        {termSubMenu && (<div className={`context-submenu ${submenuLeft === "auto" ? "flip-left" : ""}`}>
            {TERM_OPTS.map((opt) => (<div key={opt.type} className="context-menu-item" onClick={() => handleOpenInTerminal(opt.type)}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: opt.color, flexShrink: 0, display: "inline-block" }}/>
                {opt.label}
              </div>))}
          </div>)}
      </div>

      {node?.type === "file" && fileCapability === "preview" && (<>
          <div className="context-menu-divider"/>
          <div className="context-menu-item" onClick={handlePreviewFile}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            {previewLabelFor(node)}
          </div>
        </>)}

      {node?.type === "file" && fileCapability === "run" && (<>
          <div className="context-menu-divider"/>
          <div style={{ padding: "0.15rem 0.6rem 0.1rem", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Run
          </div>

          <div className="context-menu-item" onClick={handleRunFile}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            Run File
          </div>

          {guiDisplaySupported && (<div className="context-menu-item" onClick={() => void handleRunWithDisplay()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" strokeWidth="2"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
              Run with Display
            </div>)}

          <div className="context-menu-item" onClick={handleOpenCodespace}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
            Open in GitHub Codespace
          </div>
        </>)}

      {isFolder && (<>
          <div className="context-menu-divider"/>
          <div className="context-menu-item" onClick={handleNewFile}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
            New File
          </div>
          <div className="context-menu-item" onClick={handleNewFolder}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            New Folder
          </div>
        </>)}

      <div className="context-menu-divider"/>

      <div className="context-menu-item" onClick={handleSelectNode}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="m15 17 2 2 4-5"/></svg>
        Select
      </div>

      <div className="context-menu-item" onClick={handleCopyNode}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </div>

      <div className="context-menu-item" onClick={handleMoveNode}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h12"/><path d="M7 3l-4 3 4 3"/><path d="M15 18h6"/><path d="M17 15l4 3-4 3"/></svg>
        Move
      </div>

      {clipboardState && node?.type === "folder" && (<div className="context-menu-item" onClick={handlePasteHere}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Paste Here
        </div>)}

      <div className="context-menu-item" onClick={handleRename}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Rename
      </div>

      <div className="context-menu-item" onClick={handleCopyPath}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Path
      </div>

      {node?.type === "file" && (<div className="context-menu-item" onClick={handleCopyContent}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy Content
        </div>)}

      <div className="context-menu-item" onClick={handleExport}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </div>

      <div className="context-menu-divider"/>

      <div className="context-menu-item danger" onClick={handleDelete}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        Delete
      </div>
    </div>);
}
