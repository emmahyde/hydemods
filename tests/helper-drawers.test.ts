import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { loadVaultPage } from "../lib/drawer-vault";
import { DrawerView } from "../lib/drawer-view";
import type { DrawerAdapter, DrawerPage } from "../lib/drawer-types";

const scratch = join(import.meta.dir, "../.claude/scratchpad");
const ctx = {} as ExtensionContext;
const theme = { fg: (_color: string, text: string) => text } as Theme;

test("vault rejects traversal and intermediate symlinks outside its root", async () => {
 await mkdir(scratch, { recursive: true });
 const dir = await mkdtemp(join(scratch, "vault-boundary-"));
 try {
  await mkdir(join(dir, "vault")); await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "private.md"), "outside data");
  await symlink(join(dir, "outside"), join(dir, "vault", "escape"));
  const roots = new Map([["notes", join(dir, "vault")]]);
  const request = { signal: new AbortController().signal, fetch: false };
  await expect(loadVaultPage("vault://notes/../outside/private.md", roots, request)).rejects.toThrow("leaves");
  await expect(loadVaultPage("vault://notes/escape/private.md", roots, request)).rejects.toThrow("leaves");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("vault exposes note headings but keeps database content out of preview", async () => {
 await mkdir(scratch, { recursive: true });
 const dir = await mkdtemp(join(scratch, "vault-content-"));
 try {
  await writeFile(join(dir, "note.md"), "# Ore samples\nMeasured veins\n## Next cut\n");
  await writeFile(join(dir, "bank.db"), "private database payload");
  const roots = new Map([["notes", dir]]);
  const request = { signal: new AbortController().signal, fetch: false };
  const note = await loadVaultPage("vault://notes/note.md", roots, request);
  expect(note.sections.find(section => section.title === "Headings")?.lines).toEqual(["# Ore samples", "## Next cut"]);
  const db = await loadVaultPage("vault://notes/bank.db", roots, request);
  expect(db.sections.flatMap(section => section.lines).join("\n")).not.toContain("private database payload");
  expect(db.sections.find(section => section.title === "Preview")?.lines[0]).toContain("not opened");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("late navigation cannot overwrite the current inspector and narrow layouts fit", async () => {
 const slow = Promise.withResolvers<DrawerPage>();
 const adapter: DrawerAdapter = { schemes: ["vault"], async load(uri) {
  if (uri === "vault://slow") return slow.promise;
  return { uri, title: "Current folder", entries: [], sections: [{ title: "Content", lines: ["correct result"] }], status: "Ready" };
 } };
 const view = new DrawerView([adapter], ctx, theme, () => {}, () => {}, "vault://slow");
 await view.navigate("vault://fast");
 slow.resolve({ uri: "vault://slow", title: "Stale folder", entries: [], sections: [], status: "Stale result" });
 await Promise.resolve(); await Promise.resolve();
 const lines = view.render(68);
 expect(lines.join("\n")).toContain("Current folder");
 expect(lines.join("\n")).not.toContain("Stale folder");
 expect(lines.every(line => visibleWidth(line) <= 68)).toBe(true);
 view.dispose();
});

test("selection inspects without fetching; only explicit fetch can retrieve remotely", async () => {
 const requests: boolean[] = [];
 const adapter: DrawerAdapter = { schemes: ["mcp"], async load(uri, _ctx, request) {
  requests.push(request.fetch);
  return { uri, title: "Remote resource", entries: [], sections: [], status: request.fetch ? "Fetched" : "Not fetched", needsFetch: !request.fetch };
 } };
 const view = new DrawerView([adapter], ctx, theme, () => {}, () => {}, "mcp://resource");
 await view.navigate("mcp://resource");
 expect(requests.every(fetch => !fetch)).toBe(true);
 view.handleInput("\u0006");
 await Promise.resolve(); await Promise.resolve();
 expect(requests.at(-1)).toBe(true);
 view.dispose();
});

test("HelperDrawers provider invokes onPreview immediately on completion selection", () => {
	let previewedUri: string | undefined;
	const adapter: DrawerAdapter = { schemes: ["vault"], async load(uri) { return { uri, title: "Vault", entries: [], sections: [], status: "Ready" }; } };
	const drawers = new (require("../lib/helper-drawers").HelperDrawers)([adapter], () => true, (_ctx: unknown, uri: string) => {
		previewedUri = uri;
	});
	const inner = {
		getSuggestions: async () => null,
		applyCompletion: (lines: string[], line: number, col: number) => ({ lines, cursorLine: line, cursorCol: col }),
	};
	const provider = drawers.provider(inner);
	const mockCtx = {
		hasUI: true,
		ui: {
			setWidget: () => {},
			onTerminalInput: () => () => {},
			addAutocompleteProvider: () => {},
			getEditorText: () => "",
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	drawers.install(mockCtx);

	const result = provider.applyCompletion(["vault://notes/test"], 0, 18, { value: "vault://notes/test " }, "vault://notes/test");
	result.onApplied?.();
	expect(previewedUri).toBe("vault://notes/test");
});
