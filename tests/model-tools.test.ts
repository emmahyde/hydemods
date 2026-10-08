import { describe, expect, test } from "bun:test";
import { type AgentModelOverrides, clearOverride, listOverrides, type OverrideSettings, parseSelector, setOverride, withOverride, withoutOverride } from "../lib/model-tools";

describe("parseSelector", () => {
	test("splits only known effort suffixes", () => {
		expect(parseSelector("anthropic/claude-opus-5-5:high")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
		expect(parseSelector("@slow:XHigh")).toEqual({ model: "@slow", effort: "xhigh" });
	});
	test("leaves role aliases and plain ids alone", () => {
		expect(parseSelector("@slow")).toEqual({ model: "@slow" });
		expect(parseSelector("  gpt-5  ")).toEqual({ model: "gpt-5" });
	});
	test("keeps colons that belong to the model id", () => {
		expect(parseSelector("amazon-bedrock/us.amazon.nova-micro-v1:0")).toEqual({ model: "amazon-bedrock/us.amazon.nova-micro-v1:0" });
		expect(parseSelector("ollama/llama3:latest")).toEqual({ model: "ollama/llama3:latest" });
		expect(parseSelector("ollama/llama3:latest:low")).toEqual({ model: "ollama/llama3:latest", effort: "low" });
	});
	test("a bare effort word is not a selector suffix", () => {
		expect(parseSelector(":high")).toEqual({ model: ":high" });
	});
});

describe("override map helpers", () => {
	test("withOverride adds or replaces without mutating", () => {
		const base: AgentModelOverrides = { task: "a" };
		expect(withOverride(base, "task", "b")).toEqual({ task: "b" });
		expect(withOverride(base, "scout", "c")).toEqual({ task: "a", scout: "c" });
		expect(base).toEqual({ task: "a" });
	});
	test("withoutOverride drops only the named key", () => {
		expect(withoutOverride({ task: "a", scout: "c" }, "task")).toEqual({ scout: "c" });
		expect(withoutOverride({ task: "a" }, "nope")).toEqual({ task: "a" });
	});
});

/** Mimics the host: the override layer is deep-merged over the persisted record, and clearOverride drops the whole layer. */
function fakeSettings(persisted: AgentModelOverrides, layer: AgentModelOverrides = {}) {
	let overrides: AgentModelOverrides | undefined = Object.keys(layer).length ? layer : undefined;
	const settings: OverrideSettings = {
		get: () => ({ ...persisted, ...(overrides ?? {}) }),
		override: (_p, value) => {
			overrides = value;
		},
		clearOverride: () => {
			overrides = undefined;
		},
	};
	return { settings, layer: () => overrides };
}

describe("clearOverride", () => {
	test("removes a session-only override and keeps the others", () => {
		const f = fakeSettings({}, { reviewer: "x", scout: "y" });
		expect(clearOverride(f.settings, "reviewer")).toContain("Cleared");
		expect(f.settings.get("task.agentModelOverrides")).toEqual({ scout: "y" });
		expect(f.layer()).toEqual({ scout: "y" });
	});
	test("leaves no override layer when the last entry is cleared", () => {
		const f = fakeSettings({}, { reviewer: "x" });
		clearOverride(f.settings, "reviewer");
		expect(f.layer()).toBeUndefined();
	});
	test("a persisted entry survives and is reported", () => {
		const f = fakeSettings({ reviewer: "p" }, { reviewer: "x", scout: "y" });
		const msg = clearOverride(f.settings, "reviewer");
		expect(msg).toContain("persisted");
		expect(msg).toContain("/agents");
		expect(f.settings.get("task.agentModelOverrides")).toEqual({ reviewer: "p", scout: "y" });
		expect(f.layer()).toEqual({ scout: "y" });
	});
	test("unrelated persisted entries are not copied into the override layer", () => {
		const f = fakeSettings({ task: "p" }, { reviewer: "x" });
		clearOverride(f.settings, "reviewer");
		expect(f.layer()).toBeUndefined();
	});
	test("clearing an unknown agent is a no-op", () => {
		const f = fakeSettings({}, { scout: "y" });
		expect(clearOverride(f.settings, "reviewer")).toContain("No model override");
		expect(f.layer()).toEqual({ scout: "y" });
	});
});

describe("setOverride / listOverrides", () => {
	test("set merges with existing entries and list reports them", () => {
		const f = fakeSettings({}, { scout: "y" });
		expect(setOverride(f.settings, "reviewer", "anthropic/claude-opus-5-5:high")).toBe("reviewer → anthropic/claude-opus-5-5:high (session only; use /agents to persist)");
		expect(listOverrides(f.settings)).toBe("scout → y\nreviewer → anthropic/claude-opus-5-5:high");
	});
	test("list is explicit when empty", () => {
		expect(listOverrides(fakeSettings({}).settings)).toBe("No agent model overrides.");
	});
});
