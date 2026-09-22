import type { AIToolDefinition } from "../types/ide";
import type { AgentAction } from "./aiAgent";

export type ToolKind = AIToolDefinition["kind"];

export function actionToolKind(action: AgentAction): ToolKind {
  if (action.type === "run") return "terminal";
  if (action.type === "preview") return "preview";
  if (action.type === "read") return "workspace";
  if (action.type === "write" || action.type === "delete" || action.type === "rename" || action.type === "move" || action.type === "create_folder" || action.type === "project") return "workspace";
  return "workspace";
}

export function getEnabledAIToolKinds(tools: AIToolDefinition[] = []): Set<ToolKind> {
  return new Set(tools.filter((tool) => tool.enabled).map((tool) => tool.kind));
}

export function shouldAutoApproveAction(action: AgentAction, approvalMode: "ask" | "allow" | "deny", tools: AIToolDefinition[] = []) {
  if (approvalMode !== "allow") return false;
  const enabled = getEnabledAIToolKinds(tools);
  const kind = actionToolKind(action);
  return enabled.has(kind);
}
