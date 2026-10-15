import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { DrawerView, type DrawerSelection } from "./drawer-view";
import { drawerScheme, type DrawerAdapter, type DrawerPage } from "./drawer-types";
import { replaceToken, type EditorProvider } from "./url-drawers";
import { sanitizeTerminalText } from "./tool-output";
import { findInternalUrls } from "./internal-links";
import { HANDLER_APP, installLinkHandler } from "./link-bridge";

const TOKEN = /(?:^|[\s"'`(<=])([a-z]+:\/\/[^\s"'`()<>]*)$/i;
const WIDGET = "hydemods:reference-preview";

export class HelperDrawers {
 private active?: AbortController;
 private view?: DrawerView;
 private unsubscribe?: () => void;
 private context?: ExtensionContext;
 private installed = new WeakSet<object>();
 private previewGeneration = 0;
 constructor(
  private readonly adapters: readonly DrawerAdapter[],
  private readonly enabled: () => boolean = () => true,
  public onPreview?: (ctx: ExtensionContext, uri: string, page?: DrawerPage) => void,
 ) {}
 reset() {
  this.previewGeneration++;
  this.active?.abort(); this.active = undefined;
  this.view?.dispose(); this.view = undefined;
  this.unsubscribe?.(); this.unsubscribe = undefined;
  if (this.context?.hasUI) this.context.ui.setWidget(WIDGET, undefined);
 }
 install(ctx: ExtensionContext) {
  this.reset(); this.context = ctx;
  if (!ctx.hasUI) return;
  this.unsubscribe = ctx.ui.onTerminalInput(() => {
   if (!this.active) { this.previewGeneration++; ctx.ui.setWidget(WIDGET, undefined); }
   return undefined;
  });
  if (this.installed.has(ctx.ui)) return;
  this.installed.add(ctx.ui);
  ctx.ui.addAutocompleteProvider(inner => this.provider(inner as EditorProvider) as typeof inner);
 }
 provider(inner: EditorProvider): EditorProvider {
  const getSuggestions: EditorProvider["getSuggestions"] = async (lines, line, col, signal, onPartial) => {
   const token = TOKEN.exec((lines[line] ?? "").slice(0, col))?.[1];
   if (!this.enabled() || !token || !drawerScheme(token)) return inner.getSuggestions(lines, line, col, signal, onPartial);
   if (signal?.aborted) return null;
   return { prefix: token, items: [{ value: token + " ", label: `Browse ${token}`, description: "Open interactive browser and inspector; Tab inserts your selection" }] };
  };
  const applyCompletion: EditorProvider["applyCompletion"] = (lines, line, col, item, prefix) => {
   if (!this.enabled() || !drawerScheme(item.value) || !drawerScheme(prefix)) return inner.applyCompletion(lines, line, col, item, prefix);
   return { lines, cursorLine: line, cursorCol: col, onApplied: () => {
    const ctx = this.context;
    const cleanUri = item.value.trimEnd();
    if (ctx) {
     this.onPreview?.(ctx, cleanUri);
     void this.open(ctx, cleanUri, { lines: [...lines], line, col, prefix });
    }
   } };
  };
  return new Proxy(inner, { get(target, prop, receiver) {
   if (prop === "getSuggestions") return getSuggestions;
   if (prop === "applyCompletion") return applyCompletion;
   const value = Reflect.get(target, prop, receiver);
   return typeof value === "function" ? value.bind(target) : value;
  } });
 }
 /** A click on a transcript link (or a forwarded URL): steer the open browser, else open one there. */
 openFromLink(uri: string) {
  if (this.view && this.active) { void this.view.navigate(uri); return; }
  if (this.context) void this.open(this.context, uri);
 }
 async open(ctx: ExtensionContext, uri = "vault://", insertion?: { lines: string[]; line: number; col: number; prefix: string }) {
  if (!ctx.hasUI || this.active) return;
  if (!this.enabled()) { ctx.ui.notify("Enable Interactive URL drawers in /hydemods", "info"); return; }
  if (!drawerScheme(uri)) { ctx.ui.notify("Use a supported internal URL, such as vault:// or xd://", "warning"); return; }
  this.context = ctx;
  const initialText = ctx.ui.getEditorText();
  const controller = new AbortController(); this.active = controller;
  ctx.ui.setWidget(WIDGET, undefined);
  try {
   const selection = await ctx.ui.custom<DrawerSelection | undefined>((tui, theme, _keys, done) => {
    this.view = new DrawerView(this.adapters, ctx, theme, () => tui.requestRender(), done, uri);
    return this.view;
   }, { signal: controller.signal });
   if (!selection || controller.signal.aborted) return;
   if (ctx.ui.getEditorText() !== initialText) { ctx.ui.notify("Editor changed; reference insertion cancelled", "warning"); return; }
   const inserted = insertion ? replaceToken(insertion.lines, insertion.line, insertion.col, insertion.prefix, selection.uri + " ").lines.join("\n") : initialText + (initialText && !/\s$/.test(initialText) ? " " : "") + selection.uri + " ";
   ctx.ui.setEditorText(inserted);
   if (this.onPreview) {
    this.onPreview(ctx, selection.uri, selection.page);
   } else {
    this.showPreview(ctx, selection.uri, selection.page);
   }
  } catch (error) {
   if (!controller.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  } finally {
   if (this.active === controller) {
    this.view?.dispose(); this.view = undefined; this.active = undefined;
   }
  }
 }
	showPreview(ctx: ExtensionContext, uri: string, page?: DrawerPage) {
		const generation = ++this.previewGeneration;
		const render = (value?: DrawerPage) => {
			if (generation !== this.previewGeneration) return;
			const clean = (text: string) => sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
			const details = value?.entries.length ? value.entries.slice(0, 3).map(entry => entry.label) : value?.sections.flatMap(section => section.lines).slice(0, 3) ?? [];
			ctx.ui.setWidget(WIDGET, (_tui, theme) => ({
				render(width: number) { return [theme.fg("accent", truncateToWidth(` ${clean(uri)}`, width)), theme.fg("muted", truncateToWidth(` ${clean(value?.status ?? "Reference inserted")}  ${details.map(clean).join(" | ")}`, width))]; },
				invalidate() {},
			}));
		};
		render(page);
	}
}

export function registerHelperDrawers(
 pi: ExtensionAPI,
 adapters: readonly DrawerAdapter[],
 enabled: () => boolean = () => true,
 onPreview?: (ctx: ExtensionContext, uri: string, page?: DrawerPage) => void,
) {
 const drawers = new HelperDrawers(adapters, enabled, onPreview);
 pi.registerCommand("browse", {
  description: "Browse internal URLs with searchable results and a resource inspector; `install-handler` makes transcript links clickable",
  handler: async (args, ctx) => {
   const arg = args.trim();
   if (arg === "install-handler") {
    if (!ctx.hasUI) return;
    try {
     await installLinkHandler();
     ctx.ui.notify(`Installed ${HANDLER_APP}; Cmd+click internal URLs in the transcript to open them here`, "info");
    } catch (error) {
     ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return;
   }
   await drawers.open(ctx, arg || "vault://");
  },
 });
 // Opens at the internal URL nearest the end of the editor (where the cursor usually is), else the vault root.
 pi.registerShortcut("ctrl+shift+u", { description: "Browse internal URL resources (the one under the cursor when there is one)", handler: async ctx => { await drawers.open(ctx, ctx.hasUI ? findInternalUrls(ctx.ui.getEditorText()).at(-1) ?? "vault://" : "vault://"); } });
 pi.on("session_shutdown", async () => { drawers.reset(); });
 pi.on("session_switch", async (_event, ctx) => { drawers.install(ctx); });
 pi.on("session_branch", async (_event, ctx) => { drawers.install(ctx); });
 pi.on("session_tree", async (_event, ctx) => { drawers.install(ctx); });
 return drawers;
}
