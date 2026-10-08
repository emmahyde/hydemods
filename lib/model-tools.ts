import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortName = (typeof EFFORTS)[number];

export type AgentModelOverrides = Record<string, string | string[]>;

const isEffort = (value: string): value is EffortName => (EFFORTS as readonly string[]).includes(value);

/**
 * Split a trailing `:effort` off a model selector. Only a known effort name counts, so ids that
 * merely contain a colon (`amazon-bedrock/us.amazon.nova-micro-v1:0`) stay intact.
 */
export function parseSelector(selector: string): { model: string; effort?: EffortName } {
	const trimmed = selector.trim();
	const cut = trimmed.lastIndexOf(":");
	if (cut > 0) {
		const suffix = trimmed.slice(cut + 1).toLowerCase();
		if (isEffort(suffix)) return { model: trimmed.slice(0, cut), effort: suffix };
	}
	return { model: trimmed };
}

export function withOverride(map: AgentModelOverrides, agent: string, model: string): AgentModelOverrides {
	return { ...map, [agent]: model };
}

export function withoutOverride(map: AgentModelOverrides, agent: string): AgentModelOverrides {
	const { [agent]: _removed, ...rest } = map;
	return rest;
}

/** Entries of `wanted` that `base` doesn't already provide with an identical value. */
export function overrideLayer(wanted: AgentModelOverrides, base: AgentModelOverrides): AgentModelOverrides {
	const layer: AgentModelOverrides = {};
	for (const [key, value] of Object.entries(wanted)) {
		if (JSON.stringify(base[key]) !== JSON.stringify(value)) layer[key] = value;
	}
	return layer;
}

export interface OverrideSettings {
	get(path: "task.agentModelOverrides"): AgentModelOverrides;
	override(path: "task.agentModelOverrides", value: AgentModelOverrides): void;
	clearOverride(path: "task.agentModelOverrides"): void;
}

export const AGENT_MODEL_OVERRIDES_PATH = "task.agentModelOverrides" as const;
const PATH = AGENT_MODEL_OVERRIDES_PATH;

export function listOverrides(settings: OverrideSettings): string {
	const entries = Object.entries(settings.get(PATH) ?? {});
	if (!entries.length) return "No agent model overrides.";
	return entries.map(([agent, model]) => `${agent} → ${Array.isArray(model) ? model.join(", ") : model}`).join("\n");
}

export function setOverride(settings: OverrideSettings, agent: string, model: string): string {
	settings.override(PATH, withOverride(settings.get(PATH) ?? {}, agent, model));
	return `${agent} → ${model} (session only; use /agents to persist)`;
}

/**
 * Settings merge layers as global → project → config overlay → runtime overrides, and `deepMerge`
 * (config/settings.ts:2668) recurses into plain objects. The override layer for this record path is
 * therefore merged key-by-key over the persisted record: dropping a key from the override layer can
 * never hide a persisted key, and `clearOverride` (settings.ts:659) deletes the whole override
 * subtree. So clearing = wipe the layer, read what persists underneath, and re-apply only the
 * other agents' entries that differ from it.
 */
export function clearOverride(settings: OverrideSettings, agent: string): string {
	const before = settings.get(PATH) ?? {};
	settings.clearOverride(PATH);
	const base = settings.get(PATH) ?? {};
	const keep = overrideLayer(withoutOverride(before, agent), base);
	if (Object.keys(keep).length) settings.override(PATH, keep);
	if (!(agent in before)) return `No model override for "${agent}".`;
	if (agent in base) {
		const persisted = Array.isArray(base[agent]) ? (base[agent] as string[]).join(", ") : base[agent];
		return `Session override for "${agent}" removed; it still resolves to ${persisted} from persisted settings. Remove that via /agents.`;
	}
	return `Cleared model override for "${agent}".`;
}

export interface CallModelParams {
	model: string;
	prompt: string;
	system?: string;
	thinking?: EffortName;
	maxTokens?: number;
}

type Reasoning = NonNullable<Parameters<typeof completeSimple>[2]>["reasoning"];

export async function callModel(ctx: ExtensionContext, params: CallModelParams, signal?: AbortSignal) {
	const { model: selector, effort } = parseSelector(params.model);
	const model = ctx.models.resolve(selector);
	if (!model) {
		const known = ctx.models
			.list()
			.slice(0, 8)
			.map(m => `${m.provider}/${m.id}`)
			.join(", ");
		throw new Error(`Unknown model "${selector}". Try a provider/id, bare id, or @role. Available (first 8): ${known || "none"}. Run /model to see the full list.`);
	}
	const apiKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId(), { signal });
	if (!apiKey) throw new Error(`No API key available for provider "${model.provider}".`);
	signal?.throwIfAborted();
	const reasoning = (params.thinking ?? effort) as Reasoning;
	const response = await completeSimple(
		model,
		{
			...(params.system ? { systemPrompt: [params.system] } : {}),
			messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
		},
		{ apiKey, signal, ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}), ...(reasoning ? { reasoning } : {}) },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `Model call ${response.stopReason}.`);
	}
	const text = response.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	return { text, details: { model: `${model.provider}/${model.id}`, usage: response.usage, stopReason: response.stopReason } };
}

export interface AgentModelParams {
	op: "list" | "set" | "clear";
	agent?: string;
	model?: string;
}

export function agentModel(ctx: ExtensionContext, settings: OverrideSettings, params: AgentModelParams): string {
	if (params.op === "list") return listOverrides(settings);
	const agent = params.agent?.trim();
	if (!agent) throw new Error("`agent` is required for set/clear.");
	if (params.op === "clear") return clearOverride(settings, agent);
	if (!params.model) throw new Error("`model` is required for set.");
	// Store the selector as given: core resolves thinking suffixes itself.
	if (!ctx.models.resolve(parseSelector(params.model).model)) throw new Error(`Unknown model "${params.model}".`);
	return setOverride(settings, agent, params.model);
}
