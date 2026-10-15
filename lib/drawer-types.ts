import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const DRAWER_SCHEMES = ["vault", "proc", "xd", "cfg", "agent", "history", "memory", "artifact", "local", "skill", "rule", "omp", "issue", "pr", "ssh", "mcp", "security", "attachment", "conflict"] as const;
export type DrawerScheme = typeof DRAWER_SCHEMES[number];
export type DrawerEntry = { uri: string; label: string; description?: string; kind: "collection" | "resource"; };
export type DrawerSection = { title: string; lines: string[] };
export type DrawerPage = {
 uri: string;
 title: string;
 entries: DrawerEntry[];
 sections: DrawerSection[];
 status: string;
 parent?: string;
 /** Remote readers run only after the user presses the explicit Fetch control. */
 needsFetch?: boolean;
 /** Refresh visible local state; never start remote polling. */
 refreshMs?: number;
};
export type DrawerRequest = { signal: AbortSignal; fetch: boolean };
export type DrawerAdapter = {
 schemes: readonly DrawerScheme[];
 load(uri: string, ctx: ExtensionContext, request: DrawerRequest): Promise<DrawerPage>;
};
export function drawerScheme(uri: string): DrawerScheme | undefined {
 const name = /^([a-z]+):\/\//i.exec(uri)?.[1]?.toLowerCase();
 return DRAWER_SCHEMES.find(scheme => scheme === name);
}
