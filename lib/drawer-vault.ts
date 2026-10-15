import { open, opendir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { loadVaultRoots } from "./url-drawers";
import type { DrawerAdapter, DrawerEntry, DrawerPage, DrawerRequest } from "./drawer-types";

const ENTRY_LIMIT = 200;
const BYTE_LIMIT = 16_384;
const TEXT_EXTENSIONS: Record<string, true> = { ".md": true, ".txt": true, ".json": true, ".yaml": true, ".yml": true, ".csv": true, ".ts": true, ".js": true, ".css": true, ".html": true };

export async function loadVaultPage(uri: string, roots: ReadonlyMap<string, string>, request: DrawerRequest): Promise<DrawerPage> {
 request.signal.throwIfAborted();
 const parts = uri.slice("vault://".length).split("/").filter(Boolean).map(decodeURIComponent);
 const page: DrawerPage = { uri, title: "Vaults", entries: [], sections: [], status: "Local filesystem" };
 if (!parts.length) {
  page.entries = [...roots.keys()].sort().map(name => ({ uri: `vault://${encodeURIComponent(name)}/`, label: name, kind: "collection" }));
  if (!page.entries.length) page.status = "No registered Obsidian vaults";
  return page;
 }
 const name = parts.shift()!;
 const configuredRoot = roots.get(name);
 if (!configuredRoot) throw new Error(`Vault not registered: ${name}`);
 const root = await realpath(configuredRoot);
 const target = await realpath(resolve(root, ...parts));
 const within = relative(root, target);
 if (within === ".." || within.startsWith(`..${sep}`) || resolve(root, within) !== target) throw new Error("Path leaves the registered vault");
 const info = await stat(target);
 request.signal.throwIfAborted();
 const base = `vault://${encodeURIComponent(name)}/`;
 const canonical = base + within.split(sep).filter(Boolean).map(encodeURIComponent).join("/");
 page.uri = canonical + (info.isDirectory() && !canonical.endsWith("/") ? "/" : "");
 page.title = parts.at(-1) ?? name;
 page.parent = parts.length ? base + parts.slice(0, -1).map(encodeURIComponent).join("/") + (parts.length > 1 ? "/" : "") : "vault://";
 page.sections.push({ title: "Details", lines: [`Vault: ${name}`, `Type: ${info.isDirectory() ? "Folder" : "File"}`, `Modified: ${info.mtime.toISOString()}`, ...(info.isFile() ? [`Bytes: ${info.size}`] : [])] });
 if (info.isDirectory()) {
  const entries: DrawerEntry[] = [];
  let partial = false;
  for await (const entry of await opendir(target)) {
   request.signal.throwIfAborted();
   if (entries.length === ENTRY_LIMIT) { partial = true; break; }
   entries.push({ uri: page.uri + encodeURIComponent(entry.name) + (entry.isDirectory() ? "/" : ""), label: entry.name, kind: entry.isDirectory() ? "collection" : "resource", description: entry.isSymbolicLink() ? "Link (containment checked on open)" : entry.isDirectory() ? "Folder" : "File" });
  }
  entries.sort((a, b) => Number(b.kind === "collection") - Number(a.kind === "collection") || a.label.localeCompare(b.label));
  page.entries = entries;
  page.status = partial ? `Partial listing: first ${ENTRY_LIMIT} entries` : `${entries.length} entries`;
  page.sections.push({ title: "Contents", lines: entries.map(entry => `${entry.kind === "collection" ? "/ " : "  "}${entry.label}`) });
  if (!partial && !entries.some(entry => entry.label.toLowerCase().endsWith(".md"))) page.sections.push({ title: "Notes", lines: ["No Markdown notes in this folder."] });
 } else if (info.isFile() && TEXT_EXTENSIONS[extname(target).toLowerCase()] === true) {
  const file = await open(target, "r");
  try {
   const bytes = Buffer.alloc(Math.min(info.size, BYTE_LIMIT));
   const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
   request.signal.throwIfAborted();
   if (bytes.subarray(0, bytesRead).includes(0)) page.sections.push({ title: "Preview", lines: ["Binary content; metadata only."] });
   else {
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const headings = text.split("\n").filter(line => /^#{1,6} /.test(line)).slice(0, 30);
    if (headings.length) page.sections.push({ title: "Headings", lines: headings });
    page.sections.push({ title: info.size > BYTE_LIMIT ? "Excerpt (first 16 KiB)" : "Content", lines: text.split("\n") });
   }
  } finally { await file.close(); }
 } else page.sections.push({ title: "Preview", lines: ["Metadata only. Database and binary content are not opened."] });
 return page;
}

export const vaultDrawer: DrawerAdapter = {
 schemes: ["vault"],
 async load(uri, _ctx, request) { return loadVaultPage(uri, await loadVaultRoots(), request); },
};
