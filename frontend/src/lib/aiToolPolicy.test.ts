import { describe, expect, it } from "vitest";
import { actionToolKind, shouldAutoApproveAction, getEnabledAIToolKinds } from "./aiToolPolicy";

describe("aiToolPolicy", () => {
  it("maps workspace, terminal, preview, and github actions to tool kinds", () => {
    expect(actionToolKind({ type: "write", path: "/src/App.tsx" })).toBe("workspace");
    expect(actionToolKind({ type: "run", command: "npm test" })).toBe("terminal");
    expect(actionToolKind({ type: "preview", path: "/src/App.tsx" })).toBe("preview");
    expect(actionToolKind({ type: "delete", path: "/src/App.tsx" })).toBe("workspace");
  });

  it("enforces the enabled tool policy for auto approval", () => {
    const tools = [
      { id: "workspace-read", kind: "workspace", label: "Read workspace files", description: "", enabled: true },
      { id: "terminal-run", kind: "terminal", label: "Run shell commands", description: "", enabled: false },
      { id: "preview-open", kind: "preview", label: "Open previews", description: "", enabled: true },
    ] as const;

    expect(getEnabledAIToolKinds(tools)).toEqual(new Set(["workspace", "preview"]));
    expect(shouldAutoApproveAction({ type: "run", command: "npm test" }, "allow", tools)).toBe(false);
    expect(shouldAutoApproveAction({ type: "write", path: "/src/App.tsx", content: "x" }, "allow", tools)).toBe(true);
    expect(shouldAutoApproveAction({ type: "preview", path: "/src/App.tsx" }, "allow", tools)).toBe(true);
  });
});
