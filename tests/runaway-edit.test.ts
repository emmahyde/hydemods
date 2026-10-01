import { describe, expect, test } from "bun:test";
import { runawayEdit } from "../lib/runaway-edit";

const edit = (input: unknown) => [{ type: "toolCall", name: "edit", arguments: { input } }];

describe("runaway edit detection", () => {
	test("flags repeated End Patch markers once a few have streamed", () => {
		expect(runawayEdit(edit("*** End Patch\n".repeat(2)))).toBeUndefined();
		expect(runawayEdit(edit("*** End Patch\n".repeat(3)))).toMatchObject({ markers: 3 });
	});

	test("flags an implausibly large edit input even without markers", () => {
		expect(runawayEdit(edit("+x\n".repeat(40_000)))).toMatchObject({ markers: 0 });
	});

	test("ignores normal hashline edits, other tools, and partial arguments", () => {
		expect(runawayEdit(edit("[a.ts#AB12]\nPUT 1.=1:\n+x"))).toBeUndefined();
		expect(runawayEdit([{ type: "toolCall", name: "write", arguments: { content: "*** End Patch\n".repeat(10) } }])).toBeUndefined();
		expect(runawayEdit([{ type: "toolCall", name: "edit", arguments: {} }])).toBeUndefined();
		expect(runawayEdit([{ type: "text" }])).toBeUndefined();
	});
});
