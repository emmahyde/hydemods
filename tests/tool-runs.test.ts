import { describe, expect, test } from "bun:test";
import { installToolRuns, type RunCard } from "../lib/tool-runs";

class FakeCard implements RunCard {
	done = false;
	expanded = false;
	version = 0;
	render(): readonly string[] {
		return ["head", "body"];
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	updateResult(_result: { isError?: boolean }): void {
		this.done = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.done;
	}
	getTranscriptBlockVersion(): number {
		return this.version;
	}
}

const setup = () => {
	class Card extends FakeCard {}
	const runs = installToolRuns(Card.prototype, { headRow: rows => rows[0] ?? "", requestRender: () => {} });
	runs.setActive(true);
	return { Card, runs };
};

const finish = (card: FakeCard, isError = false) => card.updateResult({ isError });

describe("tool runs", () => {
	test("collapses every finished card except the newest", () => {
		const { Card } = setup();
		const [a, b] = [new Card(), new Card()];
		a.render();
		finish(a);
		b.render();
		expect(a.render()).toEqual(["head"]);
		expect(b.render()).toEqual(["head", "body"]);
	});

	test("failed and expanded cards stay full", () => {
		const { Card } = setup();
		const [a, b, c] = [new Card(), new Card(), new Card()];
		for (const card of [a, b, c]) {
			card.render();
			finish(card, card === a);
		}
		b.setExpanded(true);
		expect(a.render()).toEqual(["head", "body"]);
		expect(b.render()).toEqual(["head", "body"]);
	});

	test("cards are unfinalized until the run closes", () => {
		const { Card, runs } = setup();
		const a = new Card();
		a.render();
		finish(a);
		expect(a.isTranscriptBlockFinalized()).toBe(false);
		runs.close();
		expect(a.isTranscriptBlockFinalized()).toBe(true);
	});

	test("a finalized card first seen mid-run is never adopted", () => {
		const { Card } = setup();
		const old = new Card();
		old.done = true;
		const live = new Card();
		live.render();
		finish(live);
		const next = new Card();
		next.render();
		expect(old.render()).toEqual(["head", "body"]);
		expect(old.isTranscriptBlockFinalized()).toBe(true);
		expect(live.render()).toEqual(["head"]);
	});

	test("collapse flips change the block version", () => {
		const { Card } = setup();
		const a = new Card();
		a.render();
		finish(a);
		const before = a.getTranscriptBlockVersion();
		new Card().render();
		expect(a.getTranscriptBlockVersion()).not.toBe(before);
	});
});
