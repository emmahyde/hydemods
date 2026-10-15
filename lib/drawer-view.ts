import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeTerminalText } from "./tool-output";
import { DRAWER_SCHEMES, drawerScheme, type DrawerAdapter, type DrawerEntry, type DrawerPage } from "./drawer-types";

export type DrawerSelection = { uri: string; page?: DrawerPage };

/** A focused browser; all loads belong to one generation and one abort signal. */
export class DrawerView {
 private page?: DrawerPage;
 private detail?: DrawerPage;
 private selected = 0;
 private query = "";
 private rail = false;
 private railIndex = 0;
 private scroll = 0;
 private error = "";
 private busy = false;
 private closed = false;
 private generation = 0;
 private detailGeneration = 0;
 private request?: AbortController;
 private detailRequest?: AbortController;
 private timer?: NodeJS.Timeout;
 private trail: string[] = [];
 private uri: string;
 constructor(private readonly adapters: readonly DrawerAdapter[], private readonly ctx: ExtensionContext, private readonly theme: Theme, private readonly repaint: () => void, private readonly done: (value: DrawerSelection | undefined) => void, uri: string) {
  this.uri = uri;
  this.railIndex = Math.max(0, DRAWER_SCHEMES.indexOf(drawerScheme(uri) ?? "vault"));
  void this.navigate(uri);
 }
 private get entries(): DrawerEntry[] {
  const needle = this.query.toLowerCase();
  return (this.page?.entries ?? []).filter(entry => `${entry.label} ${entry.description ?? ""}`.toLowerCase().includes(needle));
 }
 private async load(uri: string, signal: AbortSignal, fetch: boolean): Promise<DrawerPage> {
  const scheme = drawerScheme(uri);
  const adapter = this.adapters.find(candidate => candidate.schemes.some(value => value === scheme));
  if (!adapter) throw new Error(`No drawer for ${scheme ?? uri}`);
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason ?? new Error("Read cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([adapter.load(uri, this.ctx, { signal, fetch }), aborted.promise]); }
  finally { signal.removeEventListener("abort", onAbort); }
 }
 async navigate(uri: string, fetch = false, refresh = false): Promise<void> {
  if (this.closed) return;
  clearTimeout(this.timer);
  this.request?.abort(); this.detailRequest?.abort(); this.detailGeneration++;
  const request = new AbortController(); this.request = request;
  const generation = ++this.generation;
  const selectedUri = refresh ? this.entries[this.selected]?.uri : undefined;
  this.busy = true; this.error = "";
  if (!refresh) { this.uri = uri; this.query = ""; this.selected = 0; this.scroll = 0; this.page = undefined; this.detail = undefined; }
  this.repaint();
  const timeout = setTimeout(() => request.abort(new Error("Resource read timed out")), 8000);
  try {
   const page = await this.load(uri, request.signal, fetch);
   if (this.closed || generation !== this.generation || request.signal.aborted) return;
   if (refresh && this.page) {
    const order = new Map(this.page.entries.map((entry, index) => [entry.uri, index]));
    page.entries.sort((a, b) => (order.get(a.uri) ?? Infinity) - (order.get(b.uri) ?? Infinity));
   }
   this.page = page; this.uri = page.uri;
   this.railIndex = Math.max(0, DRAWER_SCHEMES.indexOf(drawerScheme(page.uri) ?? "vault"));
   this.selected = Math.max(0, selectedUri ? this.entries.findIndex(entry => entry.uri === selectedUri) : 0);
   this.detail = page;
   void this.inspect();
   if (page.refreshMs && !page.needsFetch) this.timer = setTimeout(() => { void this.navigate(this.uri, false, true); }, Math.max(1000, page.refreshMs));
  } catch (error) {
   if (!this.closed && generation === this.generation) {
    const message = error instanceof Error ? error.message : String(error);
    const split = uri.lastIndexOf("/");
    const parent = uri.slice(0, split + 1);
    const partial = uri.slice(split + 1);
    if (!refresh && !request.signal.aborted && uri.startsWith("vault://") && partial && (message.includes("ENOENT") || message.startsWith("Vault not registered:"))) {
     await this.navigate(parent);
     if (!this.closed && this.uri === parent) {
      try { this.query = decodeURIComponent(partial); } catch { this.query = partial; }
      this.selected = 0; void this.inspect(); this.repaint();
     }
    } else this.error = request.signal.aborted ? "Resource read cancelled or timed out" : message;
   }
  } finally {
   clearTimeout(timeout);
   if (generation === this.generation && !this.closed) { this.busy = false; this.repaint(); }
  }
 }
 private async inspect(fetch = false): Promise<void> {
  this.detailRequest?.abort();
  const generation = ++this.detailGeneration;
  const entry = this.entries[this.selected];
  this.scroll = 0;
  if (!entry) { this.detail = this.page; this.repaint(); return; }
  const request = new AbortController(); this.detailRequest = request;
  this.detail = { uri: entry.uri, title: entry.label, status: "Loading details", entries: [], sections: [] };
  this.repaint();
  const timeout = setTimeout(() => request.abort(), 8000);
  try {
   const detail = await this.load(entry.uri, request.signal, fetch);
   if (!this.closed && generation === this.detailGeneration && !request.signal.aborted) this.detail = detail;
  } catch (error) {
   if (!this.closed && generation === this.detailGeneration) this.detail = { uri: entry.uri, title: entry.label, status: "Unavailable", entries: [], sections: [{ title: "Read failed", lines: [error instanceof Error ? error.message : String(error)] }] };
  } finally { clearTimeout(timeout); if (!this.closed && generation === this.detailGeneration) this.repaint(); }
 }
 dispose(): void {
  this.closed = true; this.generation++; this.detailGeneration++;
  this.request?.abort(); this.detailRequest?.abort(); clearTimeout(this.timer);
 }
 invalidate(): void { /* Width-dependent layout is rebuilt in render. */ }
 handleInput(data: string): void {
  if (matchesKey(data, Key.escape)) { this.dispose(); this.done(undefined); return; }
  if (matchesKey(data, Key.ctrl("s"))) { this.rail = !this.rail; this.repaint(); return; }
  if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
   const delta = matchesKey(data, Key.up) ? -1 : 1;
   if (this.rail) this.railIndex = (this.railIndex + delta + DRAWER_SCHEMES.length) % DRAWER_SCHEMES.length;
   else { this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + delta)); void this.inspect(); }
   this.repaint(); return;
  }
  if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) { this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.pageDown) ? 8 : -8)); this.repaint(); return; }
  if (matchesKey(data, Key.ctrl("f"))) {
   if (this.entries[this.selected] && this.detail?.needsFetch) void this.inspect(true);
   else if (this.page?.needsFetch) void this.navigate(this.uri, true);
   return;
  }
  if (matchesKey(data, Key.ctrl("r"))) { void this.navigate(this.uri, false, true); return; }
  if (matchesKey(data, Key.left)) {
   const parent = this.trail.pop() ?? this.page?.parent;
   if (parent) void this.navigate(parent);
   return;
  }
  if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
   if (this.rail) { this.rail = false; this.trail = []; void this.navigate(`${DRAWER_SCHEMES[this.railIndex]}://`); }
   else { const entry = this.entries[this.selected]; if (entry) { this.trail.push(this.uri); void this.navigate(entry.uri); } }
   return;
  }
  if (matchesKey(data, Key.tab)) {
   const uri = this.rail ? `${DRAWER_SCHEMES[this.railIndex]}://` : this.entries[this.selected]?.uri ?? this.page?.uri;
   if (uri) { const page = this.detail?.uri === uri ? this.detail : this.page?.uri === uri ? this.page : undefined; this.dispose(); this.done({ uri, page }); }
   return;
  }
  if (matchesKey(data, Key.backspace)) this.query = [...this.query].slice(0, -1).join("");
  else if (!/[\x00-\x1f\x7f]/.test(data)) this.query += data;
  else return;
  this.rail = false; this.selected = 0; void this.inspect(); this.repaint();
 }
 render(width: number): string[] {
  const w = Math.max(20, width);
  const theme = this.theme;
  const fit = (text: string, size: number) => {
   const clipped = truncateToWidth(text, Math.max(1, size));
   return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
  };
  const clean = (text: string) => sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
  const accent = (text: string) => `\x1b[38;2;239;181;65m${text}\x1b[39m`;
  const selected = (text: string, size: number) => `\x1b[48;2;239;181;65m\x1b[38;2;20;20;16m${fit(clean(text), size)}\x1b[0m`;
  const height = Math.max(6, Math.min(19, (process.stdout.rows || 36) - 12));
  const entries = this.entries;
  const top = Math.max(0, this.selected - height + 1);
  const detail = this.detail ?? this.page;
  const lines: string[] = [accent(fit(` INTERNAL URL DRAWERS   ${this.busy ? "Loading" : clean(this.page?.status ?? "Browse")}`, w)), theme.fg("border", "─".repeat(w)), fit(` ${clean(this.uri)}`, w), fit(` Filter: ${clean(this.query) || "type to search"}`, w)];
  const detailLines = [clean(detail?.title ?? "Inspect"), clean(detail?.status ?? ""), ...(detail?.sections ?? []).flatMap(section => ["", section.title.toUpperCase(), ...section.lines])];
  if (this.error) detailLines.unshift(`Read failed: ${this.error}`);
  if (w >= 100) {
   const railWidth = 15;
   const listWidth = Math.max(24, Math.floor((w - railWidth - 6) * 0.43));
   const detailWidth = w - railWidth - listWidth - 6;
   const wrapped = detailLines.flatMap(line => wrapTextWithAnsi(clean(line), detailWidth));
   this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - height));
   const railTop = Math.max(0, this.railIndex - height + 1);
   for (let row = 0; row < height; row++) {
    const scheme = DRAWER_SCHEMES[railTop + row];
    const railText = scheme ? `${this.rail && railTop + row === this.railIndex ? ">" : " "} ${scheme}` : "";
    const railCell = scheme === drawerScheme(this.uri) ? accent(fit(railText, railWidth)) : fit(railText, railWidth);
    const entry = entries[top + row];
    const label = entry ? `${entry.kind === "collection" ? "+ " : "  "}${entry.label}` : row === 0 ? this.busy ? "Loading..." : this.page?.needsFetch ? "Ctrl+F Fetch" : "No matching entries" : "";
    const cell = entry && top + row === this.selected && !this.rail ? selected(label, listWidth) : fit(clean(label), listWidth);
    lines.push(`${railCell} │ ${cell} │ ${fit(wrapped[this.scroll + row] ?? "", detailWidth)}`);
   }
  } else {
   lines.push(accent(fit(` Scheme: ${DRAWER_SCHEMES[this.railIndex]}   Ctrl+S switch`, w)));
   for (let row = 0; row < Math.min(5, height); row++) {
    const entry = entries[top + row];
    const label = entry ? `${entry.kind === "collection" ? "+ " : "  "}${entry.label}` : row === 0 ? "No matching entries" : "";
    lines.push(entry && top + row === this.selected ? selected(label, w) : fit(clean(label), w));
   }
   lines.push(theme.fg("border", "─".repeat(w)));
   const wrapped = detailLines.flatMap(line => wrapTextWithAnsi(clean(line), w));
   this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - 6));
   lines.push(...wrapped.slice(this.scroll, this.scroll + 6).map(line => fit(line, w)));
  }
  lines.push(theme.fg("border", "─".repeat(w)));
  lines.push(fit(" Up/Down Select | Right Open | Left Back | Tab Insert | Esc Close", w));
  lines.push(fit(` Ctrl+S Schemes | PgUp/PgDn Inspect | Ctrl+R Refresh${this.page?.needsFetch || this.detail?.needsFetch ? " | Ctrl+F Fetch" : ""}`, w));
  return lines;
 }
}
