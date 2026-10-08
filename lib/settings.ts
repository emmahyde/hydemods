import { lookup, register, type Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { isSettingsInitialized, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AGENT_MODEL_OVERRIDES_PATH as PATH, type AgentModelOverrides, type OverrideSettings } from "./model-tools";

export { settings };

const PREFIX = "hydemods";

function settingId(name: string): string {
	const camel = name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
	return `${PREFIX}.${camel}`;
}

/**
 * Registers a persisted boolean under `hydemods.<camelName>` in OMP's settings store, or reuses the
 * existing handle when the extension is loaded again in the same process. The value belongs to the
 * settings store, not to a session: every session in the process reads and writes the same toggle.
 */
export function booleanSetting(name: string, label: string, description: string, fallback = true): Setting<boolean> {
	const id = settingId(name);
	const existing = lookup(id);
	if (existing) return existing as Setting<boolean>;
	return register({ id, type: "boolean", default: fallback, ui: { tab: "tools", label, description } });
}

/** Registers a persisted positive integer under `hydemods.<camelName>`. */
export function integerSetting(name: string, label: string, description: string, fallback: number): Setting<number> {
	const id = settingId(name);
	const existing = lookup(id);
	if (existing) return existing as Setting<number>;
	return register({
		id,
		type: "number",
		default: fallback,
		validate: raw => {
			if (raw === undefined) return;
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new Error(`${id} must be a positive whole number`);
		},
		ui: { tab: "tools", label, description },
	});
}

/** Current value, or the setting's default before the settings store is initialized. */
export function readSetting<T>(setting: Setting<T>): T {
	return isSettingsInitialized() ? setting.get(settings) : (setting.default as T);
}

/** Observes changes from any source (panel, command, or a hand edit of settings.yaml). */
export function watchSetting<T>(setting: Setting<T>, onChange: (value: T) => void): () => void {
	if (!isSettingsInitialized()) return () => {};
	return setting.listen(settings, value => onChange(value));
}

/**
 * The host's settings store has no path-based `get`/`override`; values are reached through the
 * registry handle for the path, the same way the rest of hydemods reads host settings.
 */
export function hostOverrideSettings(): OverrideSettings {
	const setting = lookup(PATH) as Setting<AgentModelOverrides> | undefined;
	if (!setting) throw new Error(`This OMP build has no "${PATH}" setting.`);
	return {
		get: () => setting.get(settings),
		override: (_path, value) => setting.override(settings, value),
		clearOverride: () => setting.clearOverride(settings),
	};
}
