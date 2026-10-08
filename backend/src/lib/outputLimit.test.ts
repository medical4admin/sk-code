import { describe, expect, it } from "vitest";
import { appendLimitedOutput, limitTerminalChunk, parseTerminalChunk } from "./outputLimit.js";
import { dependencyInstallArgs, durableTerminalSessionName, isTransientTerminalResizeError, onceTerminalClose, RUNTIME_PROBE_DEFINITIONS, shellQuote, terminalBootstrapCommand, TERMINAL_TOOL_PROBE_DEFINITIONS, workspaceVolumeName } from "./sessionManager.js";
import { installedRuntimes } from "./runtimeRegistry.js";

describe("appendLimitedOutput", () => {
    it("caps output by UTF-8 byte length", () => {
        const result = appendLimitedOutput("ok", Buffer.from("🙂🙂"), 6);
        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(6);
        expect(result.startsWith("ok")).toBe(true);
    });

    it("does not append after the limit is reached", () => {
        expect(appendLimitedOutput("1234", Buffer.from("5678"), 4)).toBe("1234");
    });

    it("does not emit a partial UTF-8 character at a byte cap", () => {
        expect(appendLimitedOutput("", Buffer.from("🙂"), 2)).toBe("");
        expect(limitTerminalChunk("a🙂", 0, 3)).toEqual({ data: "a", sentBytes: 3, capped: true });
    });

    it("covers every declared runtime with an image probe", () => {
        expect(new Set(RUNTIME_PROBE_DEFINITIONS.map((profile) => profile.name))).toEqual(new Set(installedRuntimes.map((runtime) => runtime.name)));
    });

    it("reports the shell tools that the terminal advertises", () => {
        expect(TERMINAL_TOOL_PROBE_DEFINITIONS.map((tool) => tool.name)).toEqual(expect.arrayContaining(["bash", "tmux", "node", "npm", "npx", "git", "python3", "gcc", "g++", "javac", "kotlinc"]));
    });

    it("creates a stable, isolated tmux session name for each terminal tab", () => {
        expect(durableTerminalSessionName("terminal-one")).toBe("sk-terminal-one");
        expect(durableTerminalSessionName("tab one; rm -rf /")).toBe("sk-tab-one--rm--rf--");
        expect(durableTerminalSessionName("")).toBe("sk-shell");
    });

    it("restores and persists shell history before the first prompt", () => {
        const command = terminalBootstrapCommand();
        expect(command).toContain("HISTFILE=/workspace/.skcoder-terminal-history");
        expect(command).toContain("HISTSIZE=1000");
        expect(command).toContain("HISTFILESIZE=1000");
        expect(command).toContain("history -r");
        expect(command).toContain("PROMPT_COMMAND='history -a; printf \"__SK_CODER_CWD__%s\\n\" \"$PWD\"'");
        expect(command).toContain("exec bash --noprofile --norc -i");
    });

    it("creates one safe deterministic runner volume identity per workspace lease", () => {
        expect(workspaceVolumeName("b5d89445-f019-43ff-8991-8b2be8b757f9")).toBe("skcoder-workspace-b5d89445f01943ff89918b2be8b757f9");
        expect(workspaceVolumeName("workspace; rm -rf /")).toBe("skcoder-workspace-workspacermrf");
    });

    it("safely quotes single quotes for Bash command arguments", () => {
        expect(shellQuote("one'two")).toBe("'one'\"'\"'two'");
    });

    it("identifies only Docker's transient fresh-container resize error for retry", () => {
        expect(isTransientTerminalResizeError(new Error("container not running - cannot resize a stopped container"))).toBe(true);
        expect(isTransientTerminalResizeError(new Error("permission denied"))).toBe(false);
    });

    it("emits one terminal exit when the transport signals both end and close", () => {
        const received: number[] = [];
        const close = onceTerminalClose((code) => received.push(code));
        close(0);
        close(0);
        expect(received).toEqual([0]);
    });

    it("disables dependency lifecycle scripts for every isolated installer", () => {
        expect(dependencyInstallArgs("npm", "ci")).toEqual(expect.arrayContaining(["ci", "--ignore-scripts", "--registry=https://registry.npmjs.org/"]));
        expect(dependencyInstallArgs("pnpm", "install")).toEqual(expect.arrayContaining(["install", "--ignore-scripts", "--registry=https://registry.npmjs.org/"]));
        expect(dependencyInstallArgs("yarn", "install")).toEqual(expect.arrayContaining(["install", "--ignore-scripts", "--registry=https://registry.npmjs.org/"]));
        expect(dependencyInstallArgs("npm", "install", ["lodash@4.17.21"])).toEqual(expect.arrayContaining(["install", "lodash@4.17.21", "--ignore-scripts"]));
        expect(dependencyInstallArgs("pnpm", "install", ["react"])).toEqual(expect.arrayContaining(["add", "react", "--ignore-scripts"]));
    });

    it("removes internal cwd markers and reports the workspace-relative cwd", () => {
        expect(parseTerminalChunk("ok\r\n__SK_CODER_CWD__/workspace/project\r\n", "/")).toEqual({
            cwd: "/project",
            reachedPrompt: true,
            visible: "ok\r\n\r\n",
        });
    });

    it("recognizes cwd markers followed by tmux ANSI erase sequences", () => {
        expect(parseTerminalChunk("__SK_CODER_CWD__/workspace/project\u001b[K\r\n$ ", "/")).toEqual({
            cwd: "/project",
            reachedPrompt: true,
            visible: "\r\n$ ",
        });
    });

    it("removes tmux screen and bracketed-paste control sequences from real terminal text", () => {
        expect(parseTerminalChunk("\u001b[?2004hpwd\r\n\u001b[?2004l/workspace\r\n\u001b[K\u001b(B", "/")).toEqual({
            cwd: "/",
            reachedPrompt: false,
            visible: "pwd\r\n/workspace\r\n",
        });
    });

    it("caps terminal chunks and prevents output after the limit", () => {
        expect(limitTerminalChunk("abcdef", 0, 4)).toEqual({ data: "abcd", sentBytes: 4, capped: true });
        expect(limitTerminalChunk("later", 4, 4)).toEqual({ data: "", sentBytes: 4, capped: true });
    });
});
