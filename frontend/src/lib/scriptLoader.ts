export type PublicScript = {
    id: string;
    name: string;
    code: string;
    placement: "head" | "body";
    scope: "site" | "route";
    route?: string;
    version: number;
    updatedAt: number;
};

const loadedScriptIds = new Set<string>();

export function routeMatchesScript(script: Pick<PublicScript, "scope" | "route">, pathname: string): boolean {
    if (script.scope === "site")
        return true;
    const route = script.route?.trim().toLowerCase();
    return Boolean(route && (pathname === route || pathname.startsWith(`${route}/`)));
}

export async function loadSiteScripts(pathname: string): Promise<void> {
    const response = await fetch(`${import.meta.env.VITE_API_URL || "/api"}/scripts/public?path=${encodeURIComponent(pathname)}`);
    if (!response.ok)
        return;
    const body = await response.json() as { scripts: PublicScript[] };
    for (const script of body.scripts) {
        if (loadedScriptIds.has(script.id))
            continue;
        loadedScriptIds.add(script.id);
        const element = document.createElement("script");
        element.textContent = script.code;
        element.dataset.skScriptId = script.id;
        element.dataset.skScriptName = script.name;
        element.dataset.skScriptVersion = String(script.version);
        (script.placement === "head" ? document.head : document.body).appendChild(element);
    }
}

export function unloadSiteScripts(): void {
    for (const element of document.querySelectorAll<HTMLScriptElement>("script[data-sk-script-id]"))
        element.remove();
    loadedScriptIds.clear();
}
