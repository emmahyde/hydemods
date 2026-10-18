/**
 * Groups consecutive tool cards into a "run": tool calls with no user message and no assistant text
 * between them. Every card but the newest in a run collapses to its header row, unless it failed or
 * the card is expanded (Ctrl+O).
 *
 * Cards stay unfinalized while their run is open. The transcript commits a block to native
 * scrollback once it finalizes, and committed rows can never shrink, so an open run keeps its
 * cards in the live region until a boundary closes it.
 */

export interface RunCard {
	render(width: number): readonly string[];
	setExpanded(expanded: boolean): void;
	updateResult(result: { isError?: boolean }, isPartial?: boolean, toolCallId?: string): void;
	isTranscriptBlockFinalized(): boolean;
	getTranscriptBlockVersion(): number;
}

interface CardState {
	run: Run;
	expanded: boolean;
	failed: boolean;
	/** Bumped whenever the collapsed state flips, so the transcript re-reads the rows. */
	flips: number;
	collapsed: boolean;
}

interface Run {
	cards: RunCard[];
	open: boolean;
}

const VERSION_STRIDE = 1_000_000;
const INSTALLED = Symbol.for("hydemods.toolRuns.installed");

export interface ToolRunOptions {
	/** First row of the card, shortened to width. */
	headRow(rows: readonly string[], width: number): string;
	/** Asks the host to redraw after a run closes. */
	requestRender(): void;
}

export interface ToolRuns {
	/** A boundary (user message, assistant text, agent end) ends the current run. */
	close(): void;
	/** Tool cards only join runs while the agent is working; resumed history stays as drawn. */
	setActive(active: boolean): void;
	uninstall(): void;
}

export function uninstallToolRuns(proto: object): void {
	(proto as Record<symbol, (() => void) | undefined>)[INSTALLED]?.();
}

export function installToolRuns(proto: RunCard, options: ToolRunOptions): ToolRuns {
	uninstallToolRuns(proto);
	const states = new WeakMap<RunCard, CardState>();
	const originals = {
		render: proto.render,
		setExpanded: proto.setExpanded,
		updateResult: proto.updateResult,
		finalized: proto.isTranscriptBlockFinalized,
		version: proto.getTranscriptBlockVersion,
	};
	let active = false;
	let current: Run | undefined;

	const join = (card: RunCard): CardState | undefined => {
		const known = states.get(card);
		if (known) return known;
		if (!active) return undefined;
		if (!current?.open) current = { cards: [], open: true };
		const state: CardState = { run: current, expanded: false, failed: false, flips: 0, collapsed: false };
		current.cards.push(card);
		states.set(card, state);
		return state;
	};

	const isCollapsed = (card: RunCard, state: CardState): boolean => {
		if (state.expanded || state.failed) return false;
		const { cards } = state.run;
		if (cards[cards.length - 1] === card) return false;
		// A card still running keeps its full view.
		return originals.finalized.call(card);
	};

	proto.updateResult = function(this: RunCard, result, isPartial, toolCallId) {
		const state = join(this);
		if (state && result.isError === true) state.failed = true;
		return originals.updateResult.call(this, result, isPartial, toolCallId);
	};
	proto.setExpanded = function(this: RunCard, expanded) {
		const state = states.get(this);
		if (state) state.expanded = expanded;
		return originals.setExpanded.call(this, expanded);
	};
	proto.render = function(this: RunCard, width) {
		// Only a card still in flight can start a run; finalized ones are history re-rendered by a resize or repaint.
		const state = states.get(this) ?? (originals.finalized.call(this) ? undefined : join(this));
		const rows = originals.render.call(this, width);
		if (!state) return rows;
		const collapsed = isCollapsed(this, state);
		if (collapsed !== state.collapsed) {
			state.collapsed = collapsed;
			state.flips++;
		}
		return collapsed ? [options.headRow(rows, width)] : rows;
	};
	proto.isTranscriptBlockFinalized = function(this: RunCard) {
		const state = states.get(this);
		if (state?.run.open) return false;
		return originals.finalized.call(this);
	};
	proto.getTranscriptBlockVersion = function(this: RunCard) {
		const state = states.get(this);
		const base = originals.version.call(this);
		// Collapsing is decided at render time, so fold the pending decision in before the host compares versions.
		if (!state) return base;
		const collapsed = isCollapsed(this, state);
		return base + (state.flips + (collapsed === state.collapsed ? 0 : 1)) * VERSION_STRIDE;
	};

	const close = () => {
		if (!current?.open) return;
		current.open = false;
		current = undefined;
		options.requestRender();
	};
	const uninstall = () => {
		proto.render = originals.render;
		proto.setExpanded = originals.setExpanded;
		proto.updateResult = originals.updateResult;
		proto.isTranscriptBlockFinalized = originals.finalized;
		proto.getTranscriptBlockVersion = originals.version;
		(proto as unknown as Record<symbol, (() => void) | undefined>)[INSTALLED] = undefined;
	};
	(proto as unknown as Record<symbol, () => void>)[INSTALLED] = uninstall;
	return {
		close,
		setActive(next) {
			active = next;
			if (!next) close();
		},
		uninstall,
	};
}
