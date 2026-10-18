import { expect, test } from "bun:test";
import { orcaPaneTitle } from "../lib/orca-pane-title";

const orcaEnv = { ORCA_TERMINAL_HANDLE: "term_1", ORCA_CLI_BIN_DIR: "/Applications/Orca.app/Contents/Resources/bin" };

test("the Orca tab follows the session name: each new name once, control characters dropped, no name resets it", () => {
	const runs: string[][] = [];
	const show = orcaPaneTitle(orcaEnv, (file, args) => runs.push([file, ...args]));
	show(undefined);
	show("Fix tool rows");
	show("Fix tool rows");
	show("Jev\u001b]0;gate\u0007");
	show(undefined);
	const orca = "/Applications/Orca.app/Contents/Resources/bin/orca";
	expect(runs).toEqual([
		[orca, "terminal", "rename", "--terminal", "term_1", "--title", "Fix tool rows"],
		[orca, "terminal", "rename", "--terminal", "term_1", "--title", "Jev ]0;gate"],
		[orca, "terminal", "rename", "--terminal", "term_1", "--title", ""],
	]);
});

test("outside Orca the session name never reaches a CLI", () => {
	const runs: string[][] = [];
	orcaPaneTitle({}, (file, args) => runs.push([file, ...args]))("Fix tool rows");
	expect(runs).toEqual([]);
});
