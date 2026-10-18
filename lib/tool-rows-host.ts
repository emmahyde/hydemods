import { type Component, Container, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
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
	LineCache,
	RunSystemPrompt,
	type RunItem,
	type ToolRowsMode,
	callLabel,
	callPrompt,
	callSubject,
	fallbackLine,
	outputText,
	planRuns,
	runPrompt,
	titlesFromOutput,
	toolLabel,
	withoutLabel,
} from "./tool-rows";

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

type ResultLike = { content?: unknown; isError?: boolean; toolName?: string };
type ReadEntries = ReadonlyMap<string, { args: unknown; result?: ResultLike }>;

export interface ToolRowsHost {
	mode(): ToolRowsMode;
	/** OMP's Ctrl+O state: expanded transcripts draw native cards. */
	expanded(): boolean;
	theme(): Theme;
	complete: Complete;
	repaint(): void;
	/** Calls a grouped read block holds, as recorded by the read-group takeover. */
	readEntries(group: ReadToolGroupComponent): ReadEntries | undefined;
	/** Name and arguments for a call id, from the live stream or the session. */
	lookupCall(id: string): { name: string; args: unknown } | undefined;
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
/** Column caps: a longer label or file name pushes only its own row's title right. */
const MaxLabelWidth = 12;
const MaxSubjectWidth = 28;
/**
 * Each tool's label colour, from theme tokens so it follows the theme. Themes have few distinct
 * hues, so the frequent tools (read, grep, glob, find, edit) get different ones and rarer tools share.
 * A bash row keeps `bashMode` whatever program it names. Unlisted and MCP tools use `toolTitle`.
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
	bash: "bashMode",
	eval: "thinkingXhigh",
	task: "syntaxKeyword",
	todo: "success",
	ask: "warning",
};
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

function trimmedRows(rows: readonly string[]): number {
	let count = 0;
	for (const row of rows) if (row.replace(/\x1b\[[0-9;]*m/g, "").trim() !== "") count++;
	return count;
}

export class ToolRows {
	private readonly host: ToolRowsHost;
	private readonly lines: LineCache;
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
		this.bound.clear();
		this.noted.length = 0;
		this.changed(false);
	}

	/** Mode or expansion changed: drop plans and redraw. */
	refresh(): void {
		this.changed(true);
	}

	private active(): boolean {
		return this.host.mode() !== "cards" && !this.host.expanded();
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
		const blank = (row: string) => !row.replace(/\x1b\[[0-9;]*m/g, "").trim();
		const rows: string[] = [...(own as string[])];
		for (const child of container.children) {
			if (stateOf(child)?.owner !== component) continue;
			const render: unknown = Reflect.get(Object.getPrototypeOf(child) ?? {}, "render");
			if (typeof render !== "function") continue;
			const more: unknown = Reflect.apply(render, child, [width]);
			if (!Array.isArray(more)) continue;
			const card = [...(more as string[])];
			while (card.length && blank(card[0]!)) card.shift();
			while (card.length && blank(card.at(-1)!)) card.pop();
			if (!card.length) continue;
			// One blank row between cards, as the transcript puts between blocks; the run keeps its own trailing rows.
			const tail: string[] = [];
			while (rows.length && blank(rows.at(-1)!)) tail.push(rows.pop()!);
			rows.push("", ...card, ...tail);
		}
		return rows;
	}

	private overrideTool(component: Component, state: BlockState): void {
		const call = state.call;
		this.override(component, "updateArgs", base => (args: unknown, id: unknown) => {
			this.bindId(state, id);
			call.args = args;
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
			return [...entries].map(([id, entry]) => ({
				id,
				name: "read",
				args: entry.args,
				argsComplete: true,
				result: entry.result,
				partial: entry.result === undefined,
				sealed: false,
			}));
		}
		const call = state.call;
		if (!call.id) this.pair(state);
		if (call.id && (call.name === undefined || call.args === undefined)) {
			const found = this.host.lookupCall(call.id);
			if (found) {
				call.name ??= found.name;
				call.args ??= found.args;
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
		return fallbackLine({ i: record?.i });
	}

	/**
	 * The title request for `call`, or undefined when none is asked: a call with an intent shows it
	 * and never asks; a read waits for its output.
	 */
	private callText(call: CallState): CallText | undefined {
		if (!call.name || call.args === undefined || this.intent(call)) return undefined;
		if (!titlesFromOutput(call.name)) return { name: call.name, args: call.args };
		if (!call.result || call.partial || call.result.isError) return undefined;
		return { name: call.name, args: call.args, output: outputText(call.result.content) };
	}

	private lineKey(call: CallState): string | undefined {
		const text = this.callText(call);
		return text && `call:${callPrompt(text)}`;
	}

	/**
	 * The call's title without its file: the agent's intent as written, else the model line once it
	 * lands (`settled`), else the call's main argument. A call with a subject never falls back to its
	 * raw path or edit script; the subject column shows it.
	 */
	private title(call: CallState): { text: string; settled: boolean } {
		const intent = this.intent(call);
		if (intent) return { text: intent, settled: true };
		const text = this.callText(call);
		const subject = callSubject(call.name ?? "", call.args);
		if (text && (call.argsComplete || call.result)) {
			const key = `call:${callPrompt(text)}`;
			this.lines.request(key, CallSystemPrompt, callPrompt(text));
			const line = this.lines.get(key);
			// With a subject column the model's filename lead is redundant, and sometimes wrong; without one it is the only file named.
			const labels = [toolLabel(call.name ?? ""), callLabel(call.name ?? "", call.args)];
			if (line) return { text: withoutLabel(subject ? line.replace(/^\S+\.\w+:\s*/, "") : line, labels), settled: true };
		}
		return { text: subject ? "" : fallbackLine(call.args), settled: false };
	}

	private lineSettled(call: CallState, now: number): boolean {
		const key = this.lineKey(call);
		if (!key) return true;
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
		const lines = calls.map(call => this.stepLine(call));
		if (this.host.mode() === "group") {
			const key = this.ensureSummary(state, lines);
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
		if (this.host.mode() === "group") return [truncateToWidth(this.groupRow(state, calls, run.closed, theme), width)];
		const subjects = calls.map(call => callSubject(call.name ?? "", call.args));
		const labelWidth = Math.min(MaxLabelWidth, Math.max(...calls.map(call => callLabel(call.name ?? "tool", call.args).length)));
		const subjectWidth = Math.min(MaxSubjectWidth, Math.max(0, ...subjects.map(subject => (subject ? visibleWidth(subject) : 0))));
		return calls.map((call, index) => truncateToWidth(this.callRow(call, subjects[index], labelWidth, subjectWidth, theme), width));
	}

	private runCalls(tools: readonly Component[]): CallState[] {
		return tools.flatMap(member => {
			const memberState = stateOf(member);
			return memberState && memberState.visible ? this.callsOf(member, memberState) : [];
		});
	}

	/** One step as the group summary reads it. */
	private stepLine(call: CallState): string {
		const label = callLabel(call.name ?? "tool", call.args);
		const subject = callSubject(call.name ?? "", call.args);
		const text = [subject, this.title(call).text].filter(Boolean).join(" ");
		return text ? `${label}: ${text}` : label;
	}

	/** Group mode asks for the summary once, from the steps as they read when the run closed. */
	private ensureSummary(state: BlockState, lines: readonly string[]): string {
		if (state.summaryKey === undefined) {
			const prompt = runPrompt(lines);
			state.summaryKey = `run:${prompt}`;
			this.lines.request(state.summaryKey, RunSystemPrompt, prompt);
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
		const color = call.result?.isError ? "error" : (ToolColor[call.name ?? ""] ?? "toolTitle");
		return theme.fg(color, theme.bold(label)) + " ".repeat(Math.max(0, width - label.length));
	}

	/** `` `file.ts` `` in the theme's path colour inside dim backticks, its `:40-80` selector dimmed. */
	private subject(subject: string, theme: Theme): string {
		const selector = /:[\d+,-]+$/.exec(subject)?.[0] ?? "";
		const tick = theme.fg("dim", "`");
		return `${tick}${theme.fg("statusLinePath", subject.slice(0, subject.length - selector.length))}${selector ? theme.fg("dim", selector) : ""}${tick}`;
	}

	/** A settled title in muted text with its code words in body text; a fallback (intent) title is dim italic. */
	private body(title: { text: string; settled: boolean }, theme: Theme): string {
		if (!title.settled) return theme.fg("dim", theme.italic(title.text));
		let out = "";
		let last = 0;
		for (const match of title.text.matchAll(CodeToken)) {
			out += theme.fg("muted", title.text.slice(last, match.index)) + theme.fg("text", match[0]);
			last = match.index + match[0].length;
		}
		return out + theme.fg("muted", title.text.slice(last));
	}

	private callRow(call: CallState, subject: string | undefined, labelWidth: number, subjectWidth: number, theme: Theme): string {
		const title = this.title(call);
		const parts = [`${this.glyph(call, theme)} ${this.label(call, theme, labelWidth)}`];
		// The column is `` `subject` ``: the widest subject plus its two backticks. A row without one pads across it.
		if (subject) parts.push(this.subject(subject, theme) + " ".repeat(Math.max(0, subjectWidth - visibleWidth(subject))));
		else if (subjectWidth > 0) parts.push(" ".repeat(subjectWidth + 2));
		if (title.text) parts.push(this.body(title, theme));
		return parts.join("  ").trimEnd();
	}

	private groupRow(state: BlockState, calls: CallState[], closed: boolean, theme: Theme): string {
		const failed = calls.filter(call => call.result?.isError).length;
		const live = calls.find(call => this.running(call));
		if (closed && !live) this.ensureSummary(state, calls.map(call => this.stepLine(call)));
		const summary = state.summaryKey ? this.lines.get(state.summaryKey) : undefined;
		const separator = theme.fg("dim", " · ");
		const count = `${separator}${theme.fg("dim", `${calls.length} ${calls.length === 1 ? "call" : "calls"}`)}`;
		const failures = failed > 0 ? `${separator}${theme.fg("error", `${failed} failed`)}` : "";
		const glyph = live ? this.glyph(live, theme) : failed > 0 ? theme.fg("error", theme.status.error) : theme.fg("success", theme.status.success);
		if (summary) return `${glyph} ${theme.fg("toolTitle", theme.bold(summary))}${count}${failures}`;
		if (closed && !live) {
			const tally = new Map<string, { call: CallState; n: number }>();
			for (const call of calls) {
				const label = callLabel(call.name ?? "tool", call.args);
				const entry = tally.get(label);
				if (entry) entry.n++;
				else tally.set(label, { call, n: 1 });
			}
			const head = [...tally.values()].map(({ call, n }) => this.label(call, theme) + (n > 1 ? theme.fg("dim", ` ×${n}`) : "")).join(theme.fg("dim", ", "));
			return `${glyph} ${head}${count}${failures}`;
		}
		const latest = live ?? calls[calls.length - 1]!;
		const subject = callSubject(latest.name ?? "", latest.args);
		const title = this.title(latest);
		const parts = [this.label(latest, theme)];
		if (subject) parts.push(this.subject(subject, theme));
		if (title.text) parts.push(this.body(title, theme));
		return `${glyph} ${parts.join(" ")}${count}${failures}`;
	}
}
