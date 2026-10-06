import { execute, type ExecutionTier } from "./executorChain";
export interface ExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    executionTime: number;
    language: string;
    executor: ExecutionTier;
    capability: string;
    compiledCode?: string;
    isPreviewable: boolean;
    previewType: "html" | "text" | "code" | "json";
}
const SUPPORTED_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "python", "java", "c", "cpp", "cc", "kt", "kotlin", "rs", "rust", "go", "php", "rb", "ruby", "bash", "sh", "csharp", "cs", "scala", "sc", "swift", "perl", "pl", "lua", "pascal", "pp", "haskell", "hs", "d", "dlang", "elixir", "ex", "erlang", "erl", "ocaml", "ml", "crystal", "cr", "nim", "zig", "julia", "jl"]);
export async function unifiedExecute(language: string, code: string, options?: { allowExternalFallback?: boolean }): Promise<ExecutionResult | null> {
    const ext = language.toLowerCase().split(".").pop() || language.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext))
        return null;
    const result = await execute(ext, code, options);
    return {
        ...result,
        language: ext,
        executor: result.tier,
        isPreviewable: false,
        previewType: "text",
    };
}
export function getFileExtension(filename: string): string {
    return filename.split(".").pop()?.toLowerCase() || "";
}
export function isLanguageSupported(language: string): boolean {
    return SUPPORTED_EXTENSIONS.has(getFileExtension(language));
}
export function getLanguageLabel(ext: string): string {
    const labels: Record<string, string> = {
        js: "JavaScript", jsx: "JavaScript/React", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript/React", py: "Python", python: "Python", java: "Java", c: "C", cpp: "C++", cc: "C++", kt: "Kotlin", kotlin: "Kotlin", rs: "Rust", rust: "Rust", go: "Go", php: "PHP", rb: "Ruby", ruby: "Ruby", bash: "Bash", sh: "Shell", csharp: "C#", cs: "C#", scala: "Scala", sc: "Scala", swift: "Swift", perl: "Perl", pl: "Perl", lua: "Lua", pascal: "Pascal", pp: "Pascal", haskell: "Haskell", hs: "Haskell", d: "D", dlang: "D", elixir: "Elixir", ex: "Elixir", erlang: "Erlang", erl: "Erlang", ocaml: "OCaml", ml: "OCaml", crystal: "Crystal", cr: "Crystal", nim: "Nim", zig: "Zig", julia: "Julia", jl: "Julia",
    };
    return labels[ext.toLowerCase()] || ext.toUpperCase();
}
