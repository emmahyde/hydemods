import type { Judge } from "@oh-my-pi/pi-ai";
import { type Component, Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { fileHyperlink } from "@oh-my-pi/pi-tui/render/hyperlink";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	HookMessageComponent,
	ReadToolGroupComponent,
	TodoReminderComponent,
	ToolExecutionComponent,
	TtsrNotificationComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components";
import {
	type CallText,
	CallSystemPrompt,
	type Complete,
	IntentJudge,
	LineCache,
	RunSystemPrompt,
	type RunItem,
	type ToolRowsMode,
	callLabel,
	deviceName,
	callPrompt,
	callSubject,
	toolBullets,
	fallbackLine,
	MaxFullLineLength,
	outputText,
	planRuns,
	runPrompt,
	titlesFromOutput,
	toolLabel,
	withoutLabel,
} from "./tool-rows";
import { taskCardBody, type TaskDetails } from "./task-card";
import { displayToolLabel } from "./tool-glyphs";
import { createPathResolver } from "./path-links";

/*
 * Tool rows draw a run of consecutive tool calls from its first block (the head); the run's other
 * blocks, and the harness notices between them, draw nothing. The transcript puts a blank row
 * between blocks, so this is the only way calls sit on adjacent rows. The head holds its place in
 * the live viewport (it reports itself unfinalized) until the run closes and its model lines land,
 * so the rows written to scrollback are the finished ones.
 *
 * Everything is patched per instance when a block joins a transcript, delegating to whatever the
 * prototype holds at call time, so other hydemods wrappers on the same prototypes keep working.
 */

type ResultLike = { content?: unknown; details?: unknown; isError?: boolean; toolName?: string };
type ReadEntries = ReadonlyMap<string, { args: unknown; result?: ResultLike }>;

export interface ToolRowsHost {
	mode(): ToolRowsMode;
	/** OMP's Ctrl+O state: expanded transcripts draw native cards. */
	expanded(): boolean;
	theme(): Theme;
	/** Draw labels as pills: upper case, bold, tool colour as the fill. */
	pills?(): boolean;
	complete: Complete;
	repaint(): void;
	/** Calls a grouped read block holds, as recorded by the read-group takeover. */
	readEntries(group: ReadToolGroupComponent): ReadEntries | undefined;
	/** Name and arguments for a call id, from the live stream or the session. */
	lookupCall(id: string): { name: string; args: unknown } | undefined;
	/** The judge that decides whether an intent says enough, or undefined when none is available. */
	judge(): Judge | undefined;
	/** Whether the knowledge wiki has a page on a row's subject (`gallery.ts`, a skill name); such rows get a badge. */
	knows?(subject: string): boolean;
}

/**
 * `text` on a solid fill of the theme colour `color`, one space each side, bold, with near-black or
 * near-white text by the fill's brightness. Only a truecolour fill has a brightness to read; any other
 * colour (256-palette or terminal default) is drawn reversed instead.
 */
function pill(theme: Theme, color: ThemeColor, text: string): string {
	const fg = theme.getFgAnsi(color);
	if (!fg.includes("\x1b[38;2;")) return theme.inverse(theme.fg(color, theme.bold(` ${text} `)));
	return `${fg.replace("\x1b[38;", "\x1b[48;")}${theme.getContrastFgAnsi(color)}\x1b[1m ${text} \x1b[22;39;49m`;
}

interface CallState {
	id?: string;
	name?: string;
	args?: unknown;
	argsComplete: boolean;
	result?: ResultLike;
	partial: boolean;
	sealed: boolean;
	frame?: number;
	/** The steps before this call in its run, set as the run is read; part of the line request. */
	earlier?: readonly string[];
}

interface BlockState {
	kind: "tool" | "reads" | "harness" | "assistant";
	call: CallState;
	committed: boolean;
	visible: boolean;
	/** The frozen head that absorbed this block when the head was written to scrollback. */
	owner?: Component;
	/** Set on a head when it is written to scrollback: the run it drew, fixed from then on. */
	frozen?: { tools: Component[]; closedAt: number };
	/** Assistant blocks: whether the message shows text (undefined until its content is seen). */
	hasText?: boolean;
	/** Group mode: the summary this head asked for, fixed once asked. */
	summaryKey?: string;
	closedAt?: number;
	/** Rows epoch folded into the block version; frozen once the block is in scrollback. */
	epoch: number;
}

interface RunView {
	tools: Component[];
	quiet: Component[];
	closed: boolean;
}

type Role = { kind: "head"; run: RunView } | { kind: "member"; head: Component } | { kind: "hidden"; head: Component };

interface Plan {
	key: string;
	at: number;
	roles: Map<Component, Role>;
}

/** How long a head waits for its model lines before it lets the transcript retire it. */
const HoldMs = 4_000;
/** Marks a row whose subject has a page in the knowledge wiki. */
const WikiBadge = "◆";
/**
 * Each tool's label colour, from theme tokens so it follows the theme. Themes have few distinct
 * hues, so the frequent tools (read, grep, glob, find, edit) get different ones and rarer tools share.
 * Bash rows, MCP and `xd://` calls, and unlisted tools take a colour from their label's first letter.
 */
const ToolColor: Record<string, ThemeColor> = {
	read: "accent",
	grep: "warning",
	glob: "syntaxType",
	find: "syntaxKeyword",
	ast_grep: "syntaxNumber",
	lsp: "syntaxVariable",
	web_search: "mdLink",
	fetch: "mdLink",
	edit: "pythonMode",
	ast_edit: "pythonMode",
	write: "syntaxString",
	// bash: coloured by its program's first letter, so `git`, `bun` and `ls` rows differ.
	eval: "thinkingXhigh",
	task: "syntaxKeyword",
	todo: "success",
	ask: "warning",
};
/** Distinct hues, so labels that start with different letters mostly get different colours. */
const LetterColors: readonly ThemeColor[] = ["mdHeading", "syntaxFunction", "mdCode", "syntaxKeyword", "syntaxString", "syntaxNumber", "success", "warning"];
/** The colour for a label with no fixed one: `Git`, `Linear`, `Wiki Status` by their first letter. */
export function letterColor(label: string): ThemeColor {
	const code = label.trim().toUpperCase().charCodeAt(0);
	return LetterColors[(Number.isNaN(code) ? 0 : code) % LetterColors.length]!;
}
/** The path a row's subject names, as the agent wrote it: a read's or write's `path`, an edit's first `[file#TAG]` header. */
function subjectSource(call: CallState): string | undefined {
	const args = call.args as { path?: unknown; input?: unknown } | undefined;
	if ((call.name === "read" || call.name === "write") && typeof args?.path === "string") return args.path.trim();
	if (call.name === "edit" && typeof args?.input === "string") return /^\[([^\]#\n]+)#[0-9A-F]{4}\]/m.exec(args.input)?.[1]?.trim().replace(/^"|"$/g, "");
	return undefined;
}
/** Code-like words in a title (`lineKey`, `call_model`, `Foo::Bar`, `refund!`, `run()`), lifted out of the muted text. */
const CodeToken = /[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)+|\b[a-z_$][\w$]*[A-Z][\w$]*|\b[A-Za-z$]\w*_\w+|\b\w+(?:\(\)|[!?](?=\s|$))/g;
/** A plan is recomputed at most this often while nothing it reads has changed. */
const PlanTtlMs = 40;
const STATE = Symbol.for("hydemods.toolRows.state");
const OVERRIDDEN = Symbol.for("hydemods.toolRows.overridden");
const INSTALLED = Symbol.for("hydemods.toolRows.installed");

type Holder = { [INSTALLED]?: () => void };
type Adopted = { [STATE]?: BlockState;[OVERRIDDEN]?: string[] };

function isTranscript(container: object): boolean {
	return "renderViewport" in container && "insertChildAt" in container;
}

function stateOf(component: Component): BlockState | undefined {
	return (component as Adopted)[STATE];
}

/**
 * `next` with the agent's intent (`i`) from `prev` when `next` lacks one. OMP strips `i` from the
 * args it hands the card once the call runs; without it the row would ask the model for a line.
 */
function withIntent(next: unknown, prev: unknown): unknown {
	if (!next || typeof next !== "object" || "i" in next) return next;
	const intent = prev && typeof prev === "object" && "i" in prev ? prev.i : undefined;
	return typeof intent === "string" && intent ? { ...next, i: intent } : next;
}

function emptyCall(): CallState {
	return { argsComplete: false, partial: true, sealed: false };
}

function hasVisibleText(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const { content, errorMessage } = message as { content?: unknown; errorMessage?: unknown };
	if (typeof errorMessage === "string" && errorMessage.trim()) return true;
	if (!Array.isArray(content)) return false;
	return content.some(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" && (block as { text: string }).text.trim() !== "");
}

function blankRow(row: string): boolean {
	return row.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
}

function trimmedRows(rows: readonly string[]): number {
	return rows.filter(row => !blankRow(row)).length;
}

export class ToolRows {
	private readonly host: ToolRowsHost;
	private readonly lines: LineCache;
	private readonly intents: IntentJudge;
	private readonly paths = createPathResolver(() => process.cwd());
	private readonly transcripts = new Set<WeakRef<Container>>();
	private readonly plans = new WeakMap<Container, Plan>();
	private readonly containerOf = new WeakMap<Component, Container>();
	private readonly bound = new Set<string>();
	private readonly noted: Array<{ id: string; at: number }> = [];
	private epoch = 0;
	private idle = true;
	private width = 80;
	private repaintTimer?: Timer;

	constructor(host: ToolRowsHost) {
		this.host = host;
		// The first request also loads the model, which takes tens of seconds; heads stop waiting long before.
		this.lines = new LineCache({ complete: host.complete, onReady: () => this.changed(true), timeoutMs: 60_000 });
		this.intents = new IntentJudge({ judge: () => host.judge(), onReady: () => this.changed(true) });
	}

	/* ------------------------------ lifecycle ------------------------------ */

	install(): () => void {
		const holder = globalThis as Holder;
		holder[INSTALLED]?.();
		const proto = Container.prototype;
		const addChild = proto.addChild;
		const self = this;
		const patchedInserts = new Map<object, (component: Component, index: number) => void>();
		proto.addChild = function(this: Container, component: Component) {
			addChild.call(this, component);
			if (isTranscript(this)) self.adopt(this, component, false, patchedInserts);
		};
		const uninstall = () => {
			proto.addChild = addChild;
			for (const [target, original] of patchedInserts) Reflect.set(target, "insertChildAt", original);
			for (const ref of this.transcripts) {
				const container = ref.deref();
				if (container) for (const child of container.children) this.release(child);
			}
			this.transcripts.clear();
			this.lines.clear();
			this.intents.clear();
			clearTimeout(this.repaintTimer);
			if (holder[INSTALLED] === uninstall) holder[INSTALLED] = undefined;
		};
		holder[INSTALLED] = uninstall;
		return uninstall;
	}

	/** Agent activity: a run stays open while the agent works and closes when it goes idle. */
	setIdle(idle: boolean): void {
		if (this.idle === idle) return;
		this.idle = idle;
		this.changed(false);
	}

	/** A call id seen in the stream, in arrival order; pairs with a card created before its id reached it. */
	noteCall(id: string): void {
		if (this.bound.has(id) || this.noted.some(entry => entry.id === id)) return;
		this.noted.push({ id, at: Date.now() });
		if (this.noted.length > 64) this.noted.shift();
	}

	reset(): void {
		this.lines.clear();
		this.intents.clear();
		this.bound.clear();
		this.noted.length = 0;
		this.changed(false);
	}

	/** Mode or expansion changed: drop plans and redraw. */
	refresh(): void {
		this.changed(true);
	}

	private active(): boolean {
		const mode = this.host.mode();
		return mode !== "cards" && mode !== "ast" && !this.host.expanded();
	}

	private changed(repaint: boolean): void {
		this.epoch++;
		if (!repaint) return;
		if (this.repaintTimer !== undefined) return;
		this.repaintTimer = setTimeout(() => {
			this.repaintTimer = undefined;
			this.host.repaint();
		}, 60);
	}

	/* ------------------------------- adoption ------------------------------- */

	private adopt(container: Container, component: Component, existing: boolean, patchedInserts?: Map<object, (component: Component, index: number) => void>): void {
		this.containerOf.set(component, container);
		if (![...this.transcripts].some(ref => ref.deref() === container)) {
			this.transcripts.add(new WeakRef(container));
			this.patchInsert(container, patchedInserts);
			for (const child of container.children) if (child !== component) this.adopt(container, child, true);
		}
		if (stateOf(component)) return;
		const kind = component instanceof ToolExecutionComponent
			? "tool"
			: component instanceof ReadToolGroupComponent
				? "reads"
				: component instanceof AssistantMessageComponent
					? "assistant"
					: component instanceof CustomMessageComponent || component instanceof HookMessageComponent || component instanceof TodoReminderComponent || component instanceof TtsrNotificationComponent || component instanceof StatusNotice
						? "harness"
						: undefined;
		if (!kind) return;
		// Blocks already on screen when hydemods (re)loads may be in scrollback; never pull them into a run.
		const state: BlockState = { kind, call: emptyCall(), committed: existing && kind !== "assistant", visible: true, epoch: this.epoch };
		(component as Adopted)[STATE] = state;
		if (kind === "tool") this.overrideTool(component, state);
		else if (kind === "reads") this.overrideReads(component, state);
		else if (kind === "assistant") this.overrideAssistant(component, state);
		else this.overrideHarness(component, state);
		this.changed(false);
	}

	private patchInsert(container: Container, patched?: Map<object, (component: Component, index: number) => void>): void {
		const proto: object | null = Object.getPrototypeOf(container);
		if (!proto || !patched || patched.has(proto)) return;
		const original: unknown = Reflect.get(proto, "insertChildAt");
		if (typeof original !== "function") return;
		const self = this;
		patched.set(proto, original as (component: Component, index: number) => void);
		Reflect.set(proto, "insertChildAt", function(this: Container, component: Component, index: number) {
			Reflect.apply(original, this, [component, index]);
			if (isTranscript(this)) self.adopt(this, component, false);
		});
	}

	private release(component: Component): void {
		const adopted = component as Adopted;
		for (const key of adopted[OVERRIDDEN] ?? []) Reflect.deleteProperty(component, key);
		adopted[OVERRIDDEN] = undefined;
		adopted[STATE] = undefined;
	}

	/** Shadow one method on the instance; `base` is the prototype's method at call time. */
	private override(component: Component, key: string, make: (base: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): void {
		const proto: object | null = Object.getPrototypeOf(component);
		const base = (...args: unknown[]): unknown => {
			const method: unknown = proto ? Reflect.get(proto, key) : undefined;
			return typeof method === "function" ? Reflect.apply(method, component, args) : undefined;
		};
		Object.defineProperty(component, key, { value: make(base), configurable: true, writable: true });
		const adopted = component as Adopted;
		(adopted[OVERRIDDEN] ??= []).push(key);
	}

	private bindId(state: BlockState, id: unknown): void {
		if (typeof id !== "string" || !id || state.call.id === id) return;
		state.call.id = id;
		this.bound.add(id);
		const index = this.noted.findIndex(entry => entry.id === id);
		if (index >= 0) this.noted.splice(index, 1);
	}

	private overrideCommon(component: Component, state: BlockState): void {
		this.override(component, "render", base => (width: unknown) => {
			if (typeof width === "number") this.width = width;
			// An absorbed block's call is already drawn by its head in scrollback, whatever the mode is now.
			if (state.owner) return [];
			if (!this.active() || !state.visible) return state.frozen && state.visible ? this.nativeRun(component, base(width), width) : base(width);
			const rows = this.rowsFor(component, state, typeof width === "number" ? width : this.width);
			return rows ?? base(width);
		});
		this.override(component, "isTranscriptBlockFinalized", base => () => {
			const finalized = base() !== false;
			if (!this.active() || !finalized) return finalized;
			return this.headReady(component, state);
		});
		this.override(component, "getTranscriptBlockVersion", base => () => {
			const version = base();
			state.epoch = state.committed ? state.epoch : this.epoch;
			return (typeof version === "number" ? version : 0) + state.epoch;
		});
		this.override(component, "releaseRenderCaches", base => () => {
			if (!state.committed) this.commit(component, state);
			return base();
		});
		this.override(component, "setToolActivityVisible", base => (visible: unknown) => {
			state.visible = visible !== false;
			this.changed(false);
			return base(visible);
		});
	}

	/**
	 * A committed head drawn with rows off (cards mode, Ctrl+O, or a full replay of scrollback): its own
	 * card, then the native card of every block it absorbed, in transcript order. The absorbed blocks
	 * still draw nothing themselves, so a live redraw never repeats a call below its scrollback row.
	 */
	private nativeRun(component: Component, own: unknown, width: unknown): unknown {
		const container = this.containerFor(component);
		if (!container || !Array.isArray(own)) return own;
		const rows: string[] = [...(own as string[])];
		for (const child of container.children) {
			if (stateOf(child)?.owner !== component) continue;
			const render: unknown = Reflect.get(Object.getPrototypeOf(child) ?? {}, "render");
			if (typeof render !== "function") continue;
			const more: unknown = Reflect.apply(render, child, [width]);
			if (!Array.isArray(more)) continue;
			const card = [...(more as string[])];
			while (card.length && blankRow(card[0]!)) card.shift();
			while (card.length && blankRow(card.at(-1)!)) card.pop();
			if (!card.length) continue;
			// One blank row between cards, as the transcript puts between blocks; the run keeps its own trailing rows.
			const tail: string[] = [];
			while (rows.length && blankRow(rows.at(-1)!)) tail.push(rows.pop()!);
			rows.push("", ...card, ...tail);
		}
		return rows;
	}

	private overrideTool(component: Component, state: BlockState): void {
		const call = state.call;
		this.override(component, "updateArgs", base => (args: unknown, id: unknown) => {
			this.bindId(state, id);
			call.args = withIntent(args, call.args);
			this.changed(false);
			return base(args, id);
		});
		for (const key of ["setArgsComplete", "setExecutionStarted"]) {
			this.override(component, key, base => (id: unknown) => {
				this.bindId(state, id);
				call.argsComplete = true;
				this.changed(false);
				return base(id);
			});
		}
		this.override(component, "updateResult", base => (result: unknown, isPartial: unknown, id: unknown) => {
			this.bindId(state, id);
			if (result && typeof result === "object") {
				call.result = result as ResultLike;
				if (typeof call.result.toolName === "string") call.name ??= call.result.toolName;
			}
			call.partial = isPartial === true;
			call.argsComplete = true;
			this.changed(false);
			return base(result, isPartial, id);
		});
		this.override(component, "seal", base => () => {
			call.sealed = true;
			this.changed(false);
			return base();
		});
		this.override(component, "tickSpinner", base => (frame: unknown) => {
			if (typeof frame === "number") call.frame = frame;
			return base(frame);
		});
		this.override(component, "stopAnimation", base => () => {
			call.frame = undefined;
			return base();
		});
		this.overrideCommon(component, state);
	}

	private overrideReads(component: Component, state: BlockState): void {
		this.override(component, "updateArgs", base => (args: unknown, id: unknown) => {
			if (typeof id === "string" && id) this.bound.add(id);
			this.changed(false);
			return base(args, id);
		});
		this.override(component, "updateResult", base => (result: unknown, isPartial: unknown, id: unknown) => {
			this.changed(false);
			return base(result, isPartial, id);
		});
		this.overrideCommon(component, state);
	}

	private overrideAssistant(component: Component, state: BlockState): void {
		this.override(component, "updateContent", base => (message: unknown, options: unknown) => {
			const hasText = hasVisibleText(message);
			if (hasText !== state.hasText) {
				state.hasText = hasText;
				this.changed(false);
			}
			return base(message, options);
		});
		const hidden = () => state.owner !== undefined || (this.active() && this.roleOf(component)?.kind === "hidden");
		this.override(component, "render", base => (width: unknown) => hidden() ? [] : base(width));
		this.override(component, "getTranscriptStableRows", base => () => hidden() ? [] : base());
		this.override(component, "renderTranscriptStableRows", base => (count: unknown, width: unknown) => hidden() ? [] : base(count, width));
	}

	private overrideHarness(component: Component, state: BlockState): void {
		this.override(component, "render", base => (width: unknown) => {
			if (state.owner || (this.active() && this.roleOf(component)?.kind === "hidden")) return [];
			return base(width);
		});
		this.override(component, "releaseRenderCaches", base => () => {
			state.committed = true;
			return base();
		});
	}

	/* -------------------------------- planning ------------------------------- */

	private classify(component: Component, width: number): RunItem {
		const state = stateOf(component);
		if (state?.kind === "tool" || state?.kind === "reads") return "tool";
		if (state?.kind === "harness") return "quiet";
		if (state?.kind === "assistant") {
			if (state.hasText === undefined) {
				// Built from history: invalidate() replays its message through updateContent.
				(component as { invalidate?: () => void }).invalidate?.();
				state.hasText ??= trimmedRows(component.render(width)) > 0;
			}
			return state.hasText ? "break" : "quiet";
		}
		return trimmedRows(component.render(width)) > 0 ? "break" : "quiet";
	}

	private plan(container: Container): Plan {
		const children = container.children;
		const now = Date.now();
		const key = `${this.epoch}|${children.length}|${this.idle ? 1 : 0}`;
		const cached = this.plans.get(container);
		if (cached && cached.key === key && now - cached.at < PlanTtlMs) return cached;
		const roles = new Map<Component, Role>();
		let start = children.length;
		for (let index = 0; index < children.length; index++) {
			const state = stateOf(children[index]!);
			if ((state?.kind === "tool" || state?.kind === "reads") && !state.committed && !state.owner) {
				start = index;
				break;
			}
		}
		const span = children.slice(start);
		const runs = planRuns(span.map(child => this.classify(child, this.width)), this.idle);
		for (const run of runs) {
			const head = span[run.head]!;
			const view: RunView = { tools: run.tools.map(index => span[index]!), quiet: run.quiet.map(index => span[index]!), closed: run.closed };
			roles.set(head, { kind: "head", run: view });
			for (const member of view.tools) if (member !== head) roles.set(member, { kind: "member", head });
			for (const quiet of view.quiet) roles.set(quiet, { kind: "hidden", head });
			const state = stateOf(head);
			if (state && view.closed) state.closedAt ??= now;
		}
		const plan = { key, at: now, roles };
		this.plans.set(container, plan);
		return plan;
	}

	private roleOf(component: Component): Role | undefined {
		const container = this.containerFor(component);
		return container ? this.plan(container).roles.get(component) : undefined;
	}

	/**
	 * The transcript that holds the block now. A resumed session builds its history in one
	 * transcript and then moves the blocks into another without addChild or insertChildAt, so the
	 * container recorded at adoption can be stale (and empty).
	 */
	private containerFor(component: Component): Container | undefined {
		const recorded = this.containerOf.get(component);
		if (recorded?.children.includes(component)) return recorded;
		for (const ref of this.transcripts) {
			const container = ref.deref();
			if (!container || container === recorded || !container.children.includes(component)) continue;
			this.containerOf.set(component, container);
			return container;
		}
		return recorded;
	}

	/** The run a tool block draws, or `null` when it draws nothing; undefined leaves the native card. */
	private runFor(component: Component, state: BlockState): { tools: Component[]; closed: boolean; closedAt?: number } | null | undefined {
		if (state.owner) return null;
		if (state.frozen) return { tools: state.frozen.tools, closed: true, closedAt: state.frozen.closedAt };
		const role = this.roleOf(component);
		if (!role) return state.committed ? { tools: [component], closed: true, closedAt: 0 } : undefined;
		if (role.kind !== "head") return null;
		return { tools: role.run.tools, closed: role.run.closed, closedAt: state.closedAt };
	}

	private commit(component: Component, state: BlockState): void {
		const run = this.active() ? this.runFor(component, state) : undefined;
		state.committed = true;
		if (run && !state.frozen) {
			state.frozen = { tools: run.tools, closedAt: run.closedAt ?? Date.now() };
			for (const member of run.tools) {
				const memberState = stateOf(member);
				if (member !== component && memberState) memberState.owner = component;
			}
			const role = this.roleOf(component);
			if (role?.kind === "head") {
				for (const quiet of role.run.quiet) {
					const quietState = stateOf(quiet);
					if (quietState) quietState.owner = component;
				}
			}
		}
		this.changed(false);
	}

	/* ----------------------------- call details ------------------------------ */

	private callsOf(component: Component, state: BlockState): CallState[] {
		if (state.kind === "reads") {
			const entries = this.host.readEntries(component as ReadToolGroupComponent);
			if (!entries) return [];
			// The read group keeps only the latest args, which OMP has stripped of `i`; the stream still has it.
			return [...entries].map(([id, entry]) => ({
				id,
				name: "read",
				args: withIntent(entry.args, this.host.lookupCall(id)?.args),
				argsComplete: true,
				result: entry.result,
				partial: entry.result === undefined,
				sealed: false,
			}));
		}
		const call = state.call;
		if (!call.id) this.pair(state);
		const lacksIntent = !!call.args && typeof call.args === "object" && !("i" in call.args);
		if (call.id && (call.name === undefined || call.args === undefined || lacksIntent)) {
			const found = this.host.lookupCall(call.id);
			if (found) {
				call.name ??= found.name;
				call.args = call.args === undefined ? found.args : withIntent(call.args, found.args);
			}
		}
		return [call];
	}

	/** A card built before any update named its call takes the oldest unclaimed id from the stream. */
	private pair(state: BlockState): void {
		const cutoff = Date.now() - 120_000;
		while (this.noted.length > 0 && (this.noted[0]!.at < cutoff || this.bound.has(this.noted[0]!.id))) this.noted.shift();
		const next = this.noted[0];
		if (next) this.bindId(state, next.id);
	}

	private running(call: CallState): boolean {
		return !call.sealed && (call.result === undefined || call.partial);
	}

	/** The agent's intent (`i`) as one display line, or "" when the call has none. */
	private intent(call: CallState): string {
		const record = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : undefined;
		return fallbackLine({ i: record?.i }, MaxFullLineLength);
	}

	/**
	 * The title request for `call`, or undefined when none is asked. Every call asks, even one with an
	 * intent: the intent shows at once and the model line replaces it when it lands. A read waits for its output.
	 */
	private callText(call: CallState): CallText | undefined {
		if (!call.name || call.args === undefined) return undefined;
		const earlier = call.earlier?.length ? { earlier: call.earlier } : {};
		if (!titlesFromOutput(call.name)) return { name: call.name, args: call.args, ...earlier };
		if (!call.result || call.partial || call.result.isError) return undefined;
		return { name: call.name, args: call.args, output: outputText(call.result.content), ...earlier };
	}

	private lineKey(call: CallState): string | undefined {
		const text = this.callText(call);
		return text && `call:${callPrompt(text)}`;
	}

	/**
	 * The call's title without its file. A call with an intent shows it at once; the judge then says
	 * whether it is enough, and when it is not the model line replaces it once that lands. A call
	 * without an intent shows the model line, else its main argument. Only that wait is unsettled.
	 * A call with a subject never falls back to its raw path or edit script; the subject column shows it.
	 * Group mode shows an intent as written: its rows are passing steps, not worth a judge request.
	 */
	private title(call: CallState): { text: string; settled: boolean } {
		const intent = this.intent(call);
		const text = this.callText(call);
		const subject = callSubject(call.name ?? "", call.args);
		if (text && (call.argsComplete || call.result) && !(intent && this.host.mode() === "group")) {
			const key = `call:${callPrompt(text)}`;
			if (intent) this.intents.request(key, text, intent);
			if (!intent || this.intents.verdict(key) === false) {
				this.lines.request(key, CallSystemPrompt, callPrompt(text));
				const line = this.lines.get(key);
				// With a subject column the model's filename lead is redundant, and sometimes wrong; without one it is the only file named.
				const labels = [toolLabel(call.name ?? ""), callLabel(call.name ?? "", call.args)];
				if (line) return { text: withoutLabel(subject ? line.replace(/^\S+\.\w+:\s*/, "") : line, labels), settled: true };
			}
		}
		if (intent) return { text: intent, settled: true };
		return { text: subject ? "" : fallbackLine(call.args), settled: false };
	}

	private lineSettled(call: CallState, now: number): boolean {
		const key = this.lineKey(call);
		if (!key || this.intent(call)) return true;
		if (this.lines.get(key) !== undefined) return true;
		const asked = this.lines.requested(key);
		return asked === undefined || now - asked >= HoldMs;
	}

	/* -------------------------------- drawing -------------------------------- */

	private headReady(component: Component, state: BlockState): boolean {
		const run = this.runFor(component, state);
		if (run === undefined || run === null) return true;
		if (!run.closed) return false;
		const now = Date.now();
		for (const member of run.tools) {
			if (member === component) continue;
			const finalized: unknown = Reflect.get(Object.getPrototypeOf(member) ?? {}, "isTranscriptBlockFinalized");
			if (typeof finalized === "function" && Reflect.apply(finalized, member, []) === false) return false;
		}
		const calls = this.runCalls(run.tools);
		if (calls.length === 0) return true;
		if (this.host.mode() === "group") {
			const key = this.ensureSummary(state, calls);
			if (this.lines.get(key) !== undefined) return true;
			const asked = this.lines.requested(key);
			return asked === undefined || now - asked >= HoldMs;
		}
		return calls.every(call => this.lineSettled(call, now));
	}

	private rowsFor(component: Component, state: BlockState, width: number): readonly string[] | undefined {
		const run = this.runFor(component, state);
		if (run === undefined) return undefined;
		if (run === null) return [];
		const calls = this.runCalls(run.tools);
		if (calls.length === 0) return [];
		const theme = this.host.theme();
		// Group mode lists a burst call by call while it runs; once it ends, the summary bullets replace the calls.
		if (this.host.mode() === "group" && run.closed && !calls.some(call => this.running(call))) {
			return this.groupRows(state, calls, theme, width).map(row => truncateToWidth(row, width));
		}
		const titles = calls.map(call => this.title(call));
		const labelWidth = Math.max(...calls.map(call => visibleWidth(displayToolLabel(callLabel(call.name ?? "tool", call.args), theme.getSymbolPreset() === "ascii"))));
		const titleWidth = Math.max(0, ...titles.map(title => visibleWidth(title.text)));
		const subjects = calls.map(call => callSubject(call.name ?? "", call.args));
		const known = (subject: string) => visibleWidth(subject) + (this.host.knows?.(subject) ? visibleWidth(WikiBadge) + 1 : 0);
		const fit = { width, subjectWidth: Math.max(0, ...subjects.map(subject => (subject ? known(subject) : 0))) };
		return calls.flatMap((call, index) => [
			truncateToWidth(this.callRow(call, titles[index]!, subjects[index], labelWidth, titleWidth, theme, fit), width),
			...this.taskFooter(call, theme, width),
		]);
	}

	/** A task call's subagent footer under its row: OMP's compact agent rows, indented; empty for other calls or before progress arrives. */
	private taskFooter(call: CallState, theme: Theme, width: number): string[] {
		if (call.name !== "task") return [];
		const indent = "    ";
		const room = Number.isFinite(width) ? Math.max(20, width - indent.length) : 100;
		const body = taskCardBody(call.result?.details as TaskDetails | undefined, { expanded: false, width: room, nowMs: Date.now() }, theme);
		return (body?.lines ?? []).map(line => truncateToWidth(indent + line, Number.isFinite(width) ? width : Infinity));
	}

	/** The run's calls in order, each told the stable steps just before it, so its line request has context. */
	private runCalls(tools: readonly Component[]): CallState[] {
		const calls = tools.flatMap(member => {
			const memberState = stateOf(member);
			return memberState && memberState.visible ? this.callsOf(member, memberState) : [];
		});
		const steps = calls.map(call => {
			const text = [callSubject(call.name ?? "", call.args), fallbackLine(call.args)].filter(Boolean).join(" ");
			return `${callLabel(call.name ?? "tool", call.args)}: ${text}`.trim();
		});
		calls.forEach((call, index) => {
			call.earlier = steps.slice(Math.max(0, index - 3), index);
		});
		return calls;
	}

	/** One step as the group summary reads it; a failed step says so, since failures often mark a pivot. */
	private stepLine(call: CallState): string {
		const label = callLabel(call.name ?? "tool", call.args);
		const subject = callSubject(call.name ?? "", call.args);
		const text = [subject, this.title(call).text, call.result?.isError ? "(failed)" : ""].filter(Boolean).join(" ");
		return text ? `${label}: ${text}` : label;
	}

	/** Group mode asks for the summary once, from the steps as they read when the run closed: one item per distinct tool label. */
	private ensureSummary(state: BlockState, calls: readonly CallState[]): string {
		if (state.summaryKey === undefined) {
			const prompt = runPrompt(calls.map(call => this.stepLine(call)));
			const labels = [...new Set(calls.map(call => callLabel(call.name ?? "tool", call.args)))];
			state.summaryKey = `run:${prompt}`;
			this.lines.request(state.summaryKey, RunSystemPrompt, prompt, Date.now(), text => toolBullets(text, labels));
		}
		return state.summaryKey;
	}

	private glyph(call: CallState, theme: Theme): string {
		if (this.running(call)) {
			const frames = theme.spinnerFrames;
			const frame = call.frame === undefined || frames.length === 0 ? "•" : frames[call.frame % frames.length]!;
			return theme.fg("accent", frame);
		}
		return call.result?.isError ? theme.fg("error", theme.status.error) : theme.fg("success", theme.status.success);
	}

	private label(call: CallState, theme: Theme, width = 0): string {
		const label = callLabel(call.name ?? "tool", call.args);
		const name = call.name ?? "";
		const fixed = deviceName(name, call.args) ? undefined : ToolColor[name];
		const color = call.result?.isError ? "error" : (fixed ?? letterColor(label));
		const shown = displayToolLabel(label, theme.getSymbolPreset() === "ascii");
		const padded = shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
		if (!this.host.pills?.()) return theme.fg(color, theme.bold(padded));
		return pill(theme, color, padded);
	}

	/** `file.ts` in the theme's path colour, its `:40-80` selector dimmed; a subject the wiki knows leads with a badge. */
	private subject(subject: string, theme: Theme, call: CallState): string {
		const selector = /:[\d+,-]+$/.exec(subject)?.[0] ?? "";
		const badge = this.host.knows?.(subject) ? `${theme.fg("accent", WikiBadge)} ` : "";
		const label = `${theme.fg("statusLinePath", subject.slice(0, subject.length - selector.length))}${selector ? theme.fg("dim", selector) : ""}`;
		const source = subjectSource(call);
		const location = source && /^(.*?)(?::(\d[\d+,-]*|-\d+))?(?::[a-z]+)?$/i.exec(source);
		const path = location ? this.paths(location[1] || source!) : undefined;
		const line = location?.[2] ? Number.parseInt(location[2], 10) : undefined;
		return badge + (path ? fileHyperlink(path, label, line !== undefined && line > 0 ? { line } : undefined) : label);
	}

	/** A settled title in muted text with its code words in body text; a fallback (intent) title is dim italic. */
	private body(title: { text: string; settled: boolean }, theme: Theme): string {
		if (!title.settled) return theme.fg("dim", theme.italic(title.text));
		const text = title.text;
		let out = "";
		let last = 0;
		for (const match of text.matchAll(CodeToken)) {
			out += theme.fg("muted", text.slice(last, match.index)) + theme.fg("text", match[0]);
			last = match.index + match[0].length;
		}
		return out + theme.fg("muted", text.slice(last));
	}

	/**
	 * Glyph and label, then the title padded to the run's widest, then the subject last, so a row without one
	 * leaves no gap. When a row would pass `fit.width`, the title is cut so the run's files stay on screen and aligned.
	 */
	private callRow(call: CallState, title: { text: string; settled: boolean }, subject: string | undefined, labelWidth: number, titleWidth: number, theme: Theme, fit?: { width: number; subjectWidth: number }): string {
		const parts = [`${this.glyph(call, theme)} ${this.label(call, theme, labelWidth)}`];
		const room = subject && fit ? fit.width - visibleWidth(parts[0]!) - fit.subjectWidth - 4 : Infinity;
		const shown = room < visibleWidth(title.text) ? { ...title, text: truncateToWidth(title.text, Math.max(0, room)) } : title;
		const pad = Math.min(titleWidth, Math.max(0, room));
		if (shown.text || pad > 0) parts.push(this.body(shown, theme) + " ".repeat(Math.max(0, pad - visibleWidth(shown.text))));
		if (subject) parts.push(this.subject(subject, theme, call));
		return parts.join("  ").trimEnd();
	}

	/**
	 * A closed burst: a status row (glyph, call count, failures), then one bullet per distinct tool, in
	 * first-use order: the tool's label, then what the agent used it for and what came of it. Until the
	 * model's bullets land (or if it is slow or down), a tool's bullet is the title of its last settled
	 * call. A long bullet wraps under its own text; a Task bullet keeps its calls' subagent footers.
	 */
	private groupRows(state: BlockState, calls: CallState[], theme: Theme, width = Infinity): string[] {
		const failed = calls.filter(call => call.result?.isError).length;
		const summary = this.lines.get(this.ensureSummary(state, calls));
		const separator = theme.fg("dim", " · ");
		const count = theme.fg("dim", `${calls.length} ${calls.length === 1 ? "call" : "calls"}`);
		const failures = failed > 0 ? `${separator}${theme.fg("error", `${failed} failed`)}` : "";
		const glyph = failed > 0 ? theme.fg("error", theme.status.error) : theme.fg("success", theme.status.success);
		const byLabel = new Map<string, CallState[]>();
		for (const call of calls) {
			const label = callLabel(call.name ?? "tool", call.args);
			byLabel.set(label, [...(byLabel.get(label) ?? []), call]);
		}
		// A summary line is `<canonical label>: text`; the longest burst label that prefixes it names the item, since labels hold colons themselves.
		const known = [...byLabel.keys()].sort((a, b) => b.length - a.length);
		const items = new Map<string, string>();
		for (const line of (summary ?? "").split("\n")) {
			const label = known.find(candidate => line.startsWith(`${candidate}: `));
			if (label && !items.has(label)) items.set(label, line.slice(label.length + 2));
		}
		const bullet = theme.fg("dim", "•");
		const labelWidth = Math.max(0, ...[...byLabel.keys()].map(label => visibleWidth(displayToolLabel(label, theme.getSymbolPreset() === "ascii"))));
		const indent = "    ";
		const rows = [`${glyph} ${count}${failures}`];
		for (const [label, group] of byLabel) {
			const last = group[group.length - 1]!;
			const text = items.get(label) ?? [...group].reverse().map(call => this.title(call)).find(title => title.settled && title.text)?.text ?? "";
			const head = this.label(last, theme, labelWidth);
			const body = text ? `${head} ${this.body({ text, settled: true }, theme)}` : head;
			const lines = Number.isFinite(width) ? wrapTextWithAnsi(body, Math.max(1, width - indent.length)) : [body];
			rows.push(...lines.map((line, index) => `${index === 0 ? `  ${bullet} ` : indent}${line}`));
			for (const call of group) rows.push(...this.taskFooter(call, theme, width));
		}
		return rows;
	}
}
