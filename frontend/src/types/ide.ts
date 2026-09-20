export type FileNode = {
    id: string;
    name: string;
    type: "file" | "folder";
    content?: string;
    assetData?: string;
    assetBlobId?: string;
    assetMimeType?: string;
    assetSize?: number;
    children?: FileNode[];
    language?: string;
    path: string;
    modified?: boolean;
};
export type Tab = {
    id: string;
    fileId: string;
    path: string;
    name: string;
    modified: boolean;
    language: string;
};
export type TerminalType = "python" | "javascript" | "node" | "nodejs" | "java" | "cpp" | "shell" | "bash" | "git" | "ai" | "output";
export type TerminalLine = {
    id: string;
    type: "input" | "output" | "error" | "info" | "success";
    content: string;
    timestamp: number;
};
export type AIChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
};
export type AIProvider = "auto" | "openai" | "anthropic" | "gemini" | "groq" | "openrouter" | "compatible";
export type AIAuthorizationMode = "ask" | "allow" | "deny";
export type AIToolDefinition = {
    id: string;
    label: string;
    kind: "workspace" | "terminal" | "preview" | "github" | "mcp";
    description: string;
    enabled: boolean;
};
export type AIKeyStatus = "none" | "valid" | "invalid" | "permission_denied" | "credits_exhausted" | "rate_limited" | "unsupported" | "unreachable" | "provider_error" | "configuration_error" | "checking";
export type AIConnectionProfile = {
    id: string;
    label: string;
    provider: AIProvider;
    model: string;
    apiKey: string;
    endpoint: string;
    active: boolean;
};
export type ActivePanel = "files" | "editor" | "terminal" | "preview" | "ai" | "settings" | "cloud" | "apk";
export type PreviewViewport = "mobile" | "tablet" | "desktop";
export type ContextMenuEntry = {
    label: string;
    icon?: string;
    action: string;
    divider?: boolean;
    danger?: boolean;
};
export type ErrorEntry = {
    id: string;
    line: number;
    col?: number;
    message: string;
    severity: "error" | "warning" | "info";
    file?: string;
    filename?: string;
    code?: string;
    suggestion?: string;
};
export type Settings = {
    editor: {
        fontSize: number;
        fontFamily: string;
        tabSize: number;
        wordWrap: "on" | "off" | "wordWrapColumn";
        minimap: boolean;
        lineNumbers: "on" | "off" | "relative";
        autoSave: boolean;
        theme: "vs-dark" | "vs-light" | "hc-black";
        bracketPairs: boolean;
        smoothScrolling: boolean;
        cursorStyle: "line" | "block" | "underline";
        renderWhitespace: "none" | "boundary" | "all";
    };
    ai: {
        apiKey: string;
        apiEndpoint: string;
        model: string;
        provider: AIProvider;
        customModels: string[];
        keyStatus: AIKeyStatus;
        usePuter: boolean;
        autoContext: boolean;
        approvalMode: AIAuthorizationMode;
        tools: AIToolDefinition[];
        profiles: AIConnectionProfile[];
        activeProfileId: string;
        usageLimit: number | null;
        usageUsed: number;
    };
    storage: {
        workspacePath: string;
        useExternalStorage: boolean;
        sdCardPath: string;
        downloadPath: string;
    };
    github: {
        token: string;
        username: string;
        codespaceActive: string;
    };
    preview: {
        viewport: PreviewViewport;
        autoRefresh: boolean;
        port: string;
    };
    backend: {
        url: string;
        enabled: boolean;
    };
};
export type Codespace = {
    id: string;
    name: string;
    display_name: string;
    state: string;
    repository: {
        full_name: string;
    };
    web_url: string;
    created_at: string;
    last_used_at: string;
};
export type GitStatus = {
    modified: string[];
    staged: string[];
    untracked: string[];
    branch: string;
};
