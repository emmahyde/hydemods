import { expect, test } from "bun:test";
import { setHostAutoTitle, shouldGenerateTitle } from "../lib/session-title";

const base = { prompt: "Refactor the monitor engine into its own module", sessionName: undefined, sessionId: "s1", inFlightFor: undefined, isLocalCommand: false };

test("a real first prompt on an unnamed session earns one generation", () => {
	expect(shouldGenerateTitle(base)).toBe(true);
	expect(shouldGenerateTitle({ ...base, sessionName: "Already named" })).toBe(false);
	expect(shouldGenerateTitle({ ...base, inFlightFor: "s1" })).toBe(false);
	expect(shouldGenerateTitle({ ...base, inFlightFor: "other" })).toBe(true);
	expect(shouldGenerateTitle({ ...base, isLocalCommand: true })).toBe(false);
});

test("the host flag is set by the tweak and only cleared when the tweak set it", () => {
	const env: Record<string, string | undefined> = {};
	setHostAutoTitle(false, env);
	expect(env.PI_NO_TITLE).toBe("hydemods");
	setHostAutoTitle(true, env);
	expect(env.PI_NO_TITLE).toBeUndefined();

	const own: Record<string, string | undefined> = { PI_NO_TITLE: "1" };
	setHostAutoTitle(false, own);
	setHostAutoTitle(true, own);
	expect(own.PI_NO_TITLE).toBe("1");
});
