import { visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * Distinct backgrounds for the three transcript surfaces. The host themes already carry a
 * background for user prompts (`userMessageBg`) and tool cards (`toolPendingBg`/`toolSuccessBg`;
 * `toolErrorBg` stays red), but none for agent responses. User and tool colors are applied by
 * wrapping the live Theme's background lookups; the response color is painted onto the rows the
 * assistant message component renders.
 */
export type Surface = "user" | "assistant" | "tool";

export const SURFACES: readonly Surface[] = ["user", "assistant", "tool"];

export const SURFACE_LABELS: Record<Surface, string> = { user: "Prompt background", assistant: "Response background", tool: "Tool call background" };

export type BgPreset = { name: string; dark: string; light: string };

/** Subtle tints, one pair per theme lightness. `off` keeps the host theme's own color. */
export const BG_PRESETS: readonly BgPreset[] = [
 { name: "off", dark: "", light: "" },
 { name: "slate", dark: "#1f252d", light: "#e8ecf1" },
 { name: "blue", dark: "#16243b", light: "#e1ecfb" },
 { name: "green", dark: "#16291f", light: "#e0f2e6" },
 { name: "amber", dark: "#2d2413", light: "#f6ecd8" },
 { name: "purple", dark: "#251b32", light: "#ede5f7" },
 { name: "rose", dark: "#311a21", light: "#f8e3e8" },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: string): boolean {
 return HEX.test(value);
}

/** Hex for a surface, or undefined when it should keep the host theme color. A hex override wins over the preset. */
export function resolveBackground(preset: string, hex: string, light: boolean): string | undefined {
 if (isHexColor(hex)) return hex.toLowerCase();
 const found = BG_PRESETS.find((candidate) => candidate.name === preset);
 const value = found ? (light ? found.light : found.dark) : "";
 return value === "" ? undefined : value;
}

export function isLightHex(hex: string): boolean {
 const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
 if (!match) return false;
 const luma = 0.299 * Number.parseInt(match[1], 16) + 0.587 * Number.parseInt(match[2], 16) + 0.114 * Number.parseInt(match[3], 16);
 return luma > 140;
}

export type ColorMode = "truecolor" | "256color";

export function backgroundAnsi(hex: string, mode: ColorMode): string {
 const ansi = Bun.color(hex, mode === "truecolor" ? "ansi-16m" : "ansi-256");
 if (ansi === null) throw new Error(`Invalid color value: ${hex}`);
 return ansi.replace("\x1b[38;", "\x1b[48;");
}

const BACKGROUND_RESET = /\x1b\[(?:0|49)?m/g;

/**
 * Paints rows between the first and last non-blank row, full width, resuming the background after
 * nested resets. Leading and trailing blank rows stay untouched so the transcript container's
 * blank-edge trimming and stable-row prefix checks see the same edges as the unpainted render.
 */
export function paintRows(rows: readonly string[], width: number, ansi: string): readonly string[] {
 const isBlank = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
 let first = 0;
 while (first < rows.length && isBlank(rows[first])) first++;
 let last = rows.length - 1;
 while (last > first && isBlank(rows[last])) last--;
 if (first >= rows.length) return rows;
 return rows.map((row, index) => {
  if (index < first || index > last) return row;
  const pad = " ".repeat(Math.max(0, width - visibleWidth(row)));
  return `${ansi}${row.replace(BACKGROUND_RESET, `$&${ansi}`)}${pad}\x1b[49m`;
 });
}

export type ThemeLookups = {
 getBgHex(color: string): string;
 getBgAnsi(color: string): string;
 getColorMode(): ColorMode;
 bg(color: string, text: string): string;
 bgFill(color: string, text: string): string;
};

type AssistantRows = {
 render(width: number): readonly string[];
 renderTranscriptStableRows(count: number, width: number): readonly string[];
};

const THEME_KEY_SURFACE: Record<string, Surface> = { userMessageBg: "user", toolPendingBg: "tool", toolSuccessBg: "tool" };

const INSTALLED = Symbol.for("hydemods.messageBackgrounds");

export type MessageBackgroundOptions = {
 /** Hex for a surface given whether the active theme is light, or undefined to keep the theme color. */
 hexFor: (surface: Surface, light: boolean) => string | undefined;
 /** The live Theme instance (its prototype is the one being wrapped). */
 liveTheme: () => ThemeLookups;
};

type Installed = { uninstall: () => void };

/**
 * Wraps the Theme background lookups and the assistant message render. Reinstalling (extension
 * reload in the same process) first restores the previous originals so wrappers never stack.
 */
export function installMessageBackgrounds(themeProto: ThemeLookups, assistantProto: AssistantRows, options: MessageBackgroundOptions): () => void {
 const holder = themeProto as unknown as Record<symbol, Installed | undefined>;
 holder[INSTALLED]?.uninstall();

 const originals = {
  bg: themeProto.bg,
  bgFill: themeProto.bgFill,
  getBgAnsi: themeProto.getBgAnsi,
  getBgHex: themeProto.getBgHex,
  render: assistantProto.render,
  stable: assistantProto.renderTranscriptStableRows,
 };

 const ansiCache = new Map<string, string>();
 const cachedAnsi = (hex: string, mode: ColorMode): string => {
  const key = `${mode}${hex}`;
  let ansi = ansiCache.get(key);
  if (!ansi) {
   ansi = backgroundAnsi(hex, mode);
   ansiCache.set(key, ansi);
  }
  return ansi;
 };

 const themeOverride = (theme: ThemeLookups, color: string): { hex: string; ansi: string } | undefined => {
  const surface = THEME_KEY_SURFACE[color];
  if (!surface) return undefined;
  const light = isLightHex(originals.getBgHex.call(theme, "userMessageBg"));
  const hex = options.hexFor(surface, light);
  return hex ? { hex, ansi: cachedAnsi(hex, theme.getColorMode()) } : undefined;
 };

 themeProto.bg = function(this: ThemeLookups, color, text) {
  const override = themeOverride(this, color);
  return override ? `${override.ansi}${text}\x1b[49m` : originals.bg.call(this, color, text);
 };
 themeProto.bgFill = function(this: ThemeLookups, color, text) {
  const override = themeOverride(this, color);
  return override ? `${override.ansi}${text.replace(BACKGROUND_RESET, `$&${override.ansi}`)}\x1b[49m` : originals.bgFill.call(this, color, text);
 };
 themeProto.getBgAnsi = function(this: ThemeLookups, color) {
  return themeOverride(this, color)?.ansi ?? originals.getBgAnsi.call(this, color);
 };
 themeProto.getBgHex = function(this: ThemeLookups, color) {
  return themeOverride(this, color)?.hex ?? originals.getBgHex.call(this, color);
 };

 // The assistant component holds no theme handle, so the live Theme instance comes from options.
 const assistantAnsi = (): string | undefined => {
  const theme = options.liveTheme();
  const hex = options.hexFor("assistant", isLightHex(originals.getBgHex.call(theme, "userMessageBg")));
  return hex ? cachedAnsi(hex, theme.getColorMode()) : undefined;
 };

 assistantProto.render = function(this: AssistantRows, width) {
  const rows = originals.render.call(this, width);
  const ansi = assistantAnsi();
  return ansi ? paintRows(rows, width, ansi) : rows;
 };
 assistantProto.renderTranscriptStableRows = function(this: AssistantRows, count, width) {
  const rows = originals.stable.call(this, count, width);
  const ansi = assistantAnsi();
  return ansi ? paintRows(rows, width, ansi) : rows;
 };

 const uninstall = () => {
  themeProto.bg = originals.bg;
  themeProto.bgFill = originals.bgFill;
  themeProto.getBgAnsi = originals.getBgAnsi;
  themeProto.getBgHex = originals.getBgHex;
  assistantProto.render = originals.render;
  assistantProto.renderTranscriptStableRows = originals.stable;
  holder[INSTALLED] = undefined;
 };
 holder[INSTALLED] = { uninstall };
 return uninstall;
}
