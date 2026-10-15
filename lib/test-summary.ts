import { green } from "./colors";

// A passing test run, reduced to the one row that matters. Failing runs return undefined so the
// failure text stays on the card.

type Paint = { fg: (color: "error" | "dim" | "muted" | "accent" | "warning", text: string) => string };

const SEP = " · ";

function parseBun(text: string): { pass: number; fail: number; tests: number; files: number; time: string; expects?: number } | undefined {
	const pass = /^\s*(\d+) pass\s*$/m.exec(text)?.[1];
	const fail = /^\s*(\d+) fail\s*$/m.exec(text)?.[1];
	const ran = /Ran (\d+) tests? across (\d+) files?\. \[([\d.]+(?:ms|s))\]/.exec(text);
	if (pass === undefined || fail === undefined || !ran) return undefined;
	const expects = /^\s*(\d+) expect\(\) calls?\s*$/m.exec(text)?.[1];
	return { pass: +pass, fail: +fail, tests: +ran[1], files: +ran[2], time: ran[3], expects: expects === undefined ? undefined : +expects };
}

function parseCargo(text: string): { passed: number; failed: number; ignored: number; suites: number } | undefined {
	const results = [...text.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
	if (results.length === 0) return undefined;
	return results.reduce((sum, [, , passed, failed, ignored]) => ({ passed: sum.passed + +passed, failed: sum.failed + +failed, ignored: sum.ignored + +ignored, suites: sum.suites + 1 }), { passed: 0, failed: 0, ignored: 0, suites: 0 });
}

/** One colour-coded row for an all-green `bun test` or `cargo test` run, else undefined. */
export function testSummaryLine(text: string, theme: Paint): string | undefined {
	const bun = parseBun(text);
	if (bun) {
		if (bun.fail > 0) return undefined;
		const parts = [green(`✓ ${bun.pass} pass`), theme.fg("dim", "0 fail")];
		if (bun.expects !== undefined) parts.push(theme.fg("muted", `${bun.expects} expects`));
		parts.push(theme.fg("muted", `${bun.files} file${bun.files === 1 ? "" : "s"}`), theme.fg("accent", bun.time));
		return parts.join(theme.fg("dim", SEP));
	}
	const cargo = parseCargo(text);
	if (cargo && cargo.failed === 0 && !/^error(\[|:)/m.test(text)) {
		const parts = [green(`✓ ${cargo.passed} passed`), theme.fg("dim", "0 failed")];
		if (cargo.ignored > 0) parts.push(theme.fg("warning", `${cargo.ignored} ignored`));
		parts.push(theme.fg("muted", `${cargo.suites} suite${cargo.suites === 1 ? "" : "s"}`));
		return parts.join(theme.fg("dim", SEP));
	}
	return undefined;
}
