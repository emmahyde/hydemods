/**
 * Claude marketplace browse/install core.
 *
 * Pure, host-free logic behind the `/claude` command: install-spec parsing, a read-only
 * compatibility inspection of a plugin source tree, and the confirm-then-install decision.
 * The OMP wiring lives in `lib/marketplace.ts`, so this module stays unit-testable and never
 * reads or writes user configuration.
 *
 * The inspector mirrors what OMP's own `claude-plugins` discovery provider loads from a
 * marketplace plugin root (skills, rules, slash commands, shell hooks, tools, agents, MCP,
 * embedded LSP/DAP config) and calls out Claude-specific components OMP cannot run. It reads
 * files and directory metadata only: it never executes a plugin script or hook.
 */

import { createHash } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/* -------------------------------------------------------------------------- */
/*                            Install-spec parsing                            */
/* -------------------------------------------------------------------------- */

export type InstallScope = "user" | "project";

export interface ParsedInstallSpec {
	/** The `name@marketplace` plugin id. */
	pluginId: string;
	force: boolean;
	scope?: InstallScope;
	/** `--yes`: consent to install without an interactive confirmation prompt. */
	assumeYes: boolean;
}

export type ParseInstallSpecResult = { ok: true; value: ParsedInstallSpec } | { ok: false; error: string };

/**
 * Fast shape check for `name@marketplace`. The native `parsePluginId` remains authoritative at
 * wiring time; this only rejects obviously malformed input before any manager call.
 */
const PLUGIN_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,62}[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,62}[a-zA-Z0-9])?$/;

const INSTALL_USAGE = "Usage: /claude install <name@marketplace> [--force] [--scope user|project] [--yes]";

export interface ParseInstallSpecOptions {
	/** Accept `--yes` (non-interactive consent). Off for `inspect`, on for `install`. */
	allowYes?: boolean;
}

/** Parse the argument tail of `/claude install` (or `inspect`) into a validated plugin id. */
export function parseInstallSpec(raw: string, options: ParseInstallSpecOptions = {}): ParseInstallSpecResult {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	let force = false;
	let scope: InstallScope | undefined;
	let yes = false;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--force" || token === "-f") {
			force = true;
			continue;
		}
		if (token === "--yes" || token === "-y") {
			if (!options.allowYes) return { ok: false, error: `Unknown option: ${token}\n${INSTALL_USAGE}` };
			yes = true;
			continue;
		}
		if (token === "--user") {
			scope = "user";
			continue;
		}
		if (token === "--project") {
			scope = "project";
			continue;
		}
		if (token === "--scope") {
			const value = tokens[index + 1];
			if (value !== "user" && value !== "project") {
				return { ok: false, error: `--scope expects "user" or "project"\n${INSTALL_USAGE}` };
			}
			scope = value;
			index += 1;
			continue;
		}
		if (token.startsWith("-")) return { ok: false, error: `Unknown option: ${token}\n${INSTALL_USAGE}` };
		positional.push(token);
	}

	if (positional.length !== 1) return { ok: false, error: `Provide exactly one plugin id.\n${INSTALL_USAGE}` };
	const pluginId = positional[0]!;
	if (!PLUGIN_ID_RE.test(pluginId)) {
		return {
			ok: false,
			error: `Invalid plugin id "${pluginId}". Expected <name>@<marketplace>, e.g. pr-review-toolkit@claude-plugins-official`,
		};
	}
	// `assumeYes` never reaches the manager; the caller uses it to pick a confirm strategy.
	return { ok: true, value: { pluginId, force, assumeYes: yes, ...(scope ? { scope } : {}) } };
}

/* -------------------------------------------------------------------------- */
/*                        Compatibility inspection                            */
/* -------------------------------------------------------------------------- */

export type ComponentStatus = "supported" | "unsupported" | "ignored";

export interface ComponentReport {
	/** Stable machine id (tests and callers key off this, not the label). */
	kind: string;
	/** Human label. */
	label: string;
	status: ComponentStatus;
	/** Number of entries found (files or declared paths). */
	count: number;
	/** Bounded list of relative paths, for display. */
	paths: string[];
	/** Caveat attached to an otherwise supported component. */
	note?: string;
}

export interface CompatibilityReport {
	/** Absolute plugin root that was inspected. */
	pluginRoot: string;
	/** Manifest path relative to the root, when one was read. */
	manifestPath?: string;
	supported: ComponentReport[];
	unsupported: ComponentReport[];
	ignored: ComponentReport[];
	warnings: string[];
	/** Hard safety failures. A non-empty list MUST block installation. */
	blockers: string[];
	/**
	 * SHA-256 fingerprint of the tree's files, used to compare the audited source with the installed
	 * copy. Undefined when the tree could not be fingerprinted (budget exceeded, symlinked content,
	 * or unreadable files) — callers MUST then treat content identity as unverified.
	 */
	treeDigest?: string;
}

const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 8;
const MAX_LISTED_PATHS = 12;
const MAX_HASH_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
/** Directory names never walked: VCS metadata and installed dependencies. */
const SKIP_DIRS: Record<string, true> = { ".git": true, node_modules: true, ".hg": true, ".svn": true };

/** True when `target` is lexically inside `root`. */
function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read-only symlink audit. A link in the plugin tree whose resolved target leaves the plugin root
 * could redirect later discovery (or the installer's copy) outside the package, so it is a blocker.
 *
 * Budgets fail closed: when the walk cannot cover the whole tree, the audit is inconclusive, and the
 * plugin is reported as unsafe rather than as clean.
 */
export async function auditSymlinks(root: string): Promise<{ blockers: string[]; warnings: string[] }> {
	const blockers: string[] = [];
	const warnings: string[] = [];
	let realRoot: string;
	try {
		realRoot = await fsp.realpath(root);
	} catch {
		blockers.push(`Audit inconclusive: cannot resolve plugin root: ${root}`);
		return { blockers, warnings };
	}

	let seen = 0;
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const { dir, depth } = stack.pop()!;
		if (depth > MAX_WALK_DEPTH) {
			blockers.push(`Audit inconclusive: tree deeper than ${MAX_WALK_DEPTH} levels at ${relativeLabel(root, dir)}`);
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch (error) {
			blockers.push(`Audit inconclusive: cannot read ${relativeLabel(root, dir)} (${errorMessage(error)})`);
			continue;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > MAX_WALK_ENTRIES) {
				blockers.push(`Audit inconclusive: more than ${MAX_WALK_ENTRIES} entries`);
				return { blockers, warnings };
			}
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				let target: string;
				try {
					target = await fsp.realpath(full);
				} catch (error) {
					// A dangling link still names a path the installer may create or write through —
					// an embedded `.lsp.json` symlink to a not-yet-existing victim is exactly that — so
					// an unresolvable target is a blocker, not a warning.
					blockers.push(`Symlink target missing: ${relativeLabel(root, full)} (${errorMessage(error)})`);
					continue;
				}
				if (!within(realRoot, target)) {
					blockers.push(`Symlink escapes plugin root: ${relativeLabel(root, full)} -> ${target}`);
				}
				continue;
			}
			if (entry.isDirectory() && SKIP_DIRS[entry.name] !== true) stack.push({ dir: full, depth: depth + 1 });
		}
	}
	return { blockers, warnings };
}

/**
 * Content fingerprint of a plugin tree, used to compare the audited source with the installed copy.
 *
 * Returns undefined when the tree cannot be fingerprinted within budget or contains symlinked
 * content (whose target bytes are not part of the tree). Callers MUST then report content identity
 * as unverified rather than assuming the install matches the audited source.
 */
async function hashPluginTree(root: string): Promise<string | undefined> {
	const hash = createHash("sha256");
	const files: Array<{ relative: string; full: string }> = [];
	const stack: Array<{ dir: string; depth: number; relative: string }> = [{ dir: root, depth: 0, relative: "" }];
	let seen = 0;
	while (stack.length > 0) {
		const { dir, depth, relative } = stack.pop()!;
		if (depth > MAX_WALK_DEPTH) return undefined;
		let entries: Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > MAX_WALK_ENTRIES) return undefined;
			const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) return undefined;
			if (entry.isDirectory()) {
				if (SKIP_DIRS[entry.name] !== true) stack.push({ dir: path.join(dir, entry.name), depth: depth + 1, relative: childRelative });
				continue;
			}
			files.push({ relative: childRelative, full: path.join(dir, entry.name) });
		}
	}
	files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
	let total = 0;
	for (const file of files) {
		try {
			const stat = await fsp.stat(file.full);
			if (stat.size > MAX_HASH_FILE_BYTES) return undefined;
			total += stat.size;
			if (total > MAX_HASH_TOTAL_BYTES) return undefined;
			const content = await fsp.readFile(file.full);
			hash.update(file.relative);
			hash.update("\0");
			hash.update(content);
			hash.update("\0");
		} catch {
			return undefined;
		}
	}
	return hash.digest("hex");
}

function relativeLabel(root: string, full: string): string {
	const relative = path.relative(root, full);
	return relative === "" ? "." : relative;
}

interface PluginManifest {
	path: string;
	/** Raw parsed JSON. Fields are read through {@link readField}, which narrows per key. */
	raw: unknown;
}

/** Read one field from untrusted JSON without asserting a shape. */
function readField(container: unknown, key: string): unknown {
	if (container === null || typeof container !== "object") return undefined;
	return Reflect.get(container, key) as unknown;
}

/** True when a field is present and non-null. */
function hasField(container: unknown, key: string): boolean {
	const value = readField(container, key);
	return value !== undefined && value !== null;
}

async function readPluginManifest(root: string): Promise<{ manifest?: PluginManifest; warning?: string }> {
	for (const relative of [".omp-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
		const full = path.join(root, relative);
		const text = await fsp.readFile(full, "utf8").catch(() => undefined);
		if (text === undefined) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { warning: `Ignoring malformed manifest ${relative} (invalid JSON)` };
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { warning: `Ignoring malformed manifest ${relative} (not an object)` };
		}
		return { manifest: { path: relative, raw: parsed } };
	}
	return {};
}

/** Manifest path fields accept a string or string[]; the first populated key wins. */
function manifestPaths(manifest: unknown, keys: readonly string[]): string[] {
	for (const key of keys) {
		const value = readField(manifest, key);
		if (typeof value === "string" && value.trim()) return [value.trim()];
		if (Array.isArray(value)) {
			const paths = value
				.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
				.map(entry => entry.trim());
			if (paths.length > 0) return paths;
		}
	}
	return [];
}

async function listEntries(dir: string, match: (name: string, isDirectory: boolean) => boolean): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (match(entry.name, entry.isDirectory())) out.push(entry.name);
	}
	return out.sort();
}

/** Skills, as OMP scans them: `<dir>/SKILL.md` plus `<subdir>/SKILL.md`. */
async function findSkillEntries(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	if (existsSync(path.join(dir, "SKILL.md"))) out.push("SKILL.md");
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (existsSync(path.join(dir, entry.name, "SKILL.md"))) out.push(`${entry.name}/`);
	}
	return out.sort();
}

function component(
	kind: string,
	label: string,
	status: ComponentStatus,
	paths: string[],
	note?: string,
): ComponentReport {
	return { kind, label, status, count: paths.length, paths: paths.slice(0, MAX_LISTED_PATHS), ...(note ? { note } : {}) };
}

async function resolveDeclaredPaths(
	root: string,
	rels: string[],
	label: string,
	warnings: string[],
	blockers: string[],
): Promise<string[]> {
	const out: string[] = [];
	for (const relative of rels) {
		const full = path.resolve(root, relative);
		if (!within(root, full)) {
			blockers.push(`${label} path declared by the manifest escapes the plugin root: ${relative}`);
			continue;
		}
		try {
			await fsp.stat(full);
			out.push(relative);
		} catch {
			warnings.push(`${label} path declared by the manifest does not exist: ${relative}`);
		}
	}
	return out;
}

/**
 * Inspect a plugin source directory read-only and classify each component.
 *
 * Never executes plugin code. `blockers` must be honored by the installer.
 */
export async function inspectPluginDirectory(root: string): Promise<CompatibilityReport> {
	const resolvedRoot = path.resolve(root);
	const report: CompatibilityReport = {
		pluginRoot: resolvedRoot,
		supported: [],
		unsupported: [],
		ignored: [],
		warnings: [],
		blockers: [],
	};

	try {
		const stat = await fsp.stat(resolvedRoot);
		if (!stat.isDirectory()) {
			report.blockers.push(`Plugin source is not a directory: ${resolvedRoot}`);
			return report;
		}
	} catch {
		report.blockers.push(`Plugin source directory not found: ${resolvedRoot}`);
		return report;
	}

	const audit = await auditSymlinks(resolvedRoot);
	report.blockers.push(...audit.blockers);
	report.warnings.push(...audit.warnings);
	report.treeDigest = await hashPluginTree(resolvedRoot);
	if (report.treeDigest === undefined) {
		report.blockers.push("Cannot fingerprint this plugin source; installation requires a verifiable snapshot.");
	}

	const { manifest, warning } = await readPluginManifest(resolvedRoot);
	if (warning) report.warnings.push(warning);
	if (manifest) report.manifestPath = manifest.path;
	const raw = manifest?.raw;

	/* ----------------------------- supported ----------------------------- */

	const declaredSkills = manifestPaths(raw, ["skills"]);
	const skillPaths =
		declaredSkills.length > 0
			? await resolveDeclaredPaths(resolvedRoot, declaredSkills, "skills", report.warnings, report.blockers)
			: await findSkillEntries(path.join(resolvedRoot, "skills"));
	if (skillPaths.length > 0) {
		report.supported.push(component("skills", "Skills", "supported", skillPaths, "Loaded by OMP as skills."));
	}

	const rulePaths = (
		await listEntries(path.join(resolvedRoot, "rules"), name => /\.(md|mdc)$/i.test(name))
	).map(name => `rules/${name}`);
	if (rulePaths.length > 0) {
		report.supported.push(component("rules", "Rules", "supported", rulePaths, "Loaded by OMP as rules."));
	}

	const declaredCommands = manifestPaths(raw, ["commands", "slash-commands"]);
	const commandPaths =
		declaredCommands.length > 0
			? await resolveDeclaredPaths(resolvedRoot, declaredCommands, "commands", report.warnings, report.blockers)
			: (await listEntries(path.join(resolvedRoot, "commands"), name => /\.md$/i.test(name) || name.endsWith(".md"))).map(
					name => `commands/${name}`,
				);
	if (commandPaths.length > 0) {
		report.supported.push(
			component(
				"commands",
				"Slash commands",
				"supported",
				commandPaths,
				"Loaded as slash commands. Claude-only frontmatter fields (e.g. allowed-tools) are not enforced.",
			),
		);
	}

	const shellHooks = [
		...(await listEntries(path.join(resolvedRoot, "hooks", "pre"), name => /\.(sh|bash|zsh|fish)$/i.test(name))).map(
			name => `hooks/pre/${name}`,
		),
		...(await listEntries(path.join(resolvedRoot, "hooks", "post"), name => /\.(sh|bash|zsh|fish)$/i.test(name))).map(
			name => `hooks/post/${name}`,
		),
	];
	if (shellHooks.length > 0) {
		report.supported.push(component("hooks", "Shell hooks", "supported", shellHooks, "Loaded as OMP shell hooks."));
	}

	const toolPaths = (await listEntries(path.join(resolvedRoot, "tools"), name => /\.(ts|js)$/i.test(name))).map(
		name => `tools/${name}`,
	);
	if (toolPaths.length > 0) {
		report.supported.push(component("tools", "Tools", "supported", toolPaths, "Loaded as OMP custom tools."));
	}

	const agentPaths = (await listEntries(path.join(resolvedRoot, "agents"), name => /\.md$/i.test(name))).map(
		name => `agents/${name}`,
	);
	if (agentPaths.length > 0) {
		report.supported.push(
			component(
				"agents",
				"Agents",
				"supported",
				agentPaths,
				"Loaded as OMP task agents. Claude-dialect model aliases in frontmatter are dropped.",
			),
		);
	}

	const mcpDeclared = manifestPaths(raw, ["mcpServers"]);
	if (mcpDeclared.length > 0) {
		const resolved = await resolveDeclaredPaths(resolvedRoot, mcpDeclared, "mcpServers", report.warnings, report.blockers);
		if (resolved.length > 0) {
			report.supported.push(component("mcp", "MCP servers", "supported", resolved, "Loaded as MCP servers."));
		}
	} else if (hasField(raw, "mcpServers")) {
		report.supported.push(component("mcp", "MCP servers", "supported", ["manifest: mcpServers"], "Loaded as MCP servers."));
	} else if (existsSync(path.join(resolvedRoot, ".mcp.json"))) {
		report.supported.push(component("mcp", "MCP servers", "supported", [".mcp.json"], "Loaded from .mcp.json."));
	}

	/* Embedded configs OMP loads from the plugin root; the installer also generates these. */
	const lspFiles = [".lsp.json"].filter(relative => existsSync(path.join(resolvedRoot, relative)));
	if (lspFiles.length > 0) {
		report.supported.push(
			component("lsp", "LSP servers", "supported", lspFiles, "Embedded config; OMP starts these language servers."),
		);
	} else {
		const lspDeclared = manifestPaths(raw, ["lspServers"]);
		if (lspDeclared.length > 0) {
			const resolved = await resolveDeclaredPaths(resolvedRoot, lspDeclared, "lspServers", report.warnings, report.blockers);
			if (resolved.length > 0) report.supported.push(component("lsp", "LSP servers", "supported", resolved));
		} else if (hasField(raw, "lspServers")) {
			report.supported.push(component("lsp", "LSP servers", "supported", ["manifest: lspServers"]));
		}
	}

	const dapFiles = [".dap.json", ".dap.yaml", ".dap.yml"].filter(relative => existsSync(path.join(resolvedRoot, relative)));
	if (dapFiles.length > 0) {
		report.supported.push(
			component("dap", "DAP adapters", "supported", dapFiles, "Embedded config; OMP launches these debug adapters."),
		);
	} else {
		const dapDeclared = manifestPaths(raw, ["dapAdapters"]);
		if (dapDeclared.length > 0) {
			const resolved = await resolveDeclaredPaths(resolvedRoot, dapDeclared, "dapAdapters", report.warnings, report.blockers);
			if (resolved.length > 0) report.supported.push(component("dap", "DAP adapters", "supported", resolved));
		} else if (hasField(raw, "dapAdapters")) {
			report.supported.push(component("dap", "DAP adapters", "supported", ["manifest: dapAdapters"]));
		}
	}

	/* ---------------------------- unsupported ---------------------------- */

	const claudeHookPaths: string[] = [];
	if (existsSync(path.join(resolvedRoot, "hooks", "hooks.json"))) claudeHookPaths.push("hooks/hooks.json");
	if (hasField(raw, "hooks")) claudeHookPaths.push("manifest: hooks");
	if (claudeHookPaths.length > 0) {
		report.unsupported.push(
			component(
				"claude-hooks",
				"Claude hook config",
				"unsupported",
				claudeHookPaths,
				"OMP loads hooks/pre and hooks/post shell scripts, not Claude's hooks.json matchers. Its commands are never executed.",
			),
		);
	}

	const settingsPaths = [
		".claude/settings.json",
		".claude/settings.local.json",
		"settings.json",
		".claude-plugin/settings.json",
	].filter(relative => existsSync(path.join(resolvedRoot, relative)));
	if (settingsPaths.length > 0) {
		report.unsupported.push(
			component("claude-settings", "Plugin settings", "unsupported", settingsPaths, "OMP does not read plugin-scoped settings."),
		);
	}

	const outputStyleDirs = ["output-styles", "outputStyles"].filter(relative =>
		existsSync(path.join(resolvedRoot, relative)),
	);
	if (outputStyleDirs.length > 0) {
		report.unsupported.push(
			component("output-styles", "Output styles", "unsupported", outputStyleDirs, "Claude output styles have no OMP equivalent."),
		);
	}

	if (existsSync(path.join(resolvedRoot, "themes"))) {
		report.unsupported.push(component("themes", "Themes", "unsupported", ["themes"], "Claude plugin themes are not applied."));
	}

	/* ------------------------------ ignored ------------------------------ */

	const marketplaceFiles = ["marketplace.json", ".claude-plugin/marketplace.json"].filter(relative =>
		existsSync(path.join(resolvedRoot, relative)),
	);
	if (marketplaceFiles.length > 0) {
		report.ignored.push(component("marketplace-metadata", "Marketplace metadata", "ignored", marketplaceFiles));
	}

	if (existsSync(path.join(resolvedRoot, "scripts"))) {
		report.ignored.push(
			component("scripts", "Scripts", "ignored", ["scripts/"], "Not loaded; never executed during inspection or install."),
		);
	}

	const packageJsonPath = path.join(resolvedRoot, "package.json");
	const packageJson = await fsp.readFile(packageJsonPath, "utf8").catch(() => undefined);
	if (packageJson !== undefined) {
		try {
			const parsed: unknown = JSON.parse(packageJson);
			if (parsed !== null && typeof parsed === "object" && "dependencies" in parsed) {
				const deps = parsed.dependencies;
				if (deps !== null && typeof deps === "object" && Object.keys(deps).length > 0) {
					report.warnings.push(
						"Plugin declares npm dependencies; OMP does not install them for marketplace plugins.",
					);
				}
			}
		} catch {
			report.warnings.push("Ignoring malformed package.json");
		}
	}

	if (manifest?.path !== undefined && manifest.path === "plugin.json") {
		report.warnings.push("Using a root plugin.json; OMP prefers .claude-plugin/plugin.json or .omp-plugin/plugin.json.");
	}

	return report;
}

/* -------------------------------------------------------------------------- */
/*                              Reporting                                     */
/* -------------------------------------------------------------------------- */

function formatComponents(heading: string, components: readonly ComponentReport[], marker: string): string[] {
	if (components.length === 0) return [];
	const lines = [heading];
	for (const entry of components) {
		const paths = entry.paths.length > 0 ? ` (${entry.paths.join(", ")})` : "";
		lines.push(`  ${marker} ${entry.label} [${entry.count}]${paths}`);
		if (entry.note) lines.push(`      ${entry.note}`);
	}
	return lines;
}

/** Human-readable compatibility report for transcript output. */
export function formatCompatibilityReport(report: CompatibilityReport): string {
	const lines = [`Compatibility: ${report.pluginRoot}`];
	lines.push(`Manifest: ${report.manifestPath ?? "none"}`);
	lines.push(
		...formatComponents("Supported (loaded by OMP):", report.supported, "+"),
		...formatComponents("Unsupported (Claude-specific, skipped):", report.unsupported, "-"),
		...formatComponents("Ignored:", report.ignored, "~"),
	);
	if (report.blockers.length > 0) {
		lines.push("Blockers:");
		for (const blocker of report.blockers) lines.push(`  ! ${blocker}`);
	}
	if (report.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of report.warnings) lines.push(`  ? ${warning}`);
	}
	if (report.supported.length === 0 && report.unsupported.length === 0 && report.ignored.length === 0) {
		lines.push("No installable components detected.");
	}
	return lines.join("\n");
}

/** Component kinds that run code or launch processes once loaded. */
const CODE_RUNNING_KINDS: Record<string, true> = { hooks: true, tools: true, mcp: true, lsp: true, dap: true };

export type PluginOrigin = "local" | "remote";

/**
 * Confirmation text shown before an install.
 *
 * States which components run code after reload and identifies the install scope.
 * Remote content is pinned before inspection; installation uses that same snapshot.
 */
export function formatPreInstallSummary(
	pluginId: string,
	report: CompatibilityReport,
	options: { force?: boolean; scope?: InstallScope; origin?: PluginOrigin } = {},
): string {
	const supported = report.supported.reduce((sum, entry) => sum + entry.count, 0);
	const lines = [`Install ${pluginId}?`];
	lines.push(`Components OMP will load: ${supported}`);
	if (report.unsupported.length > 0) {
		lines.push(`Unsupported components skipped: ${report.unsupported.map(entry => entry.label).join(", ")}`);
	}
	const codeRunning = report.supported.filter(entry => CODE_RUNNING_KINDS[entry.kind] === true).map(entry => entry.label);
	if (codeRunning.length > 0) {
		lines.push(`After reload, these components run code or launch processes: ${codeRunning.join(", ")}`);
	}
	lines.push("Nothing is loaded until you run /reload-plugins.");
	if (options.origin === "remote") {
		lines.push("Remote source: installation uses the pinned snapshot inspected above, without fetching it again.");
	}
	if (options.force) lines.push("Reinstalling an existing plugin (--force).");
	lines.push(`Scope: ${options.scope ?? "user"}`);
	lines.push("", formatCompatibilityReport(report));
	return lines.join("\n");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/*                        Installed-payload verification                      */
/* -------------------------------------------------------------------------- */

export interface PayloadVerification {
	/** True only when the installed tree is audited clean AND matches the audited source. */
	ok: boolean;
	/** Compatibility report for the path OMP actually installed. */
	report: CompatibilityReport;
	/** Reasons the payload could not be verified; empty when `ok`. */
	problems: string[];
}

/** Catalog files the native add/update path persists into the marketplace cache. */
const MARKETPLACE_CATALOG_FILES = ["marketplace.json", ".claude-plugin/marketplace.json"];

/**
 * Audit a marketplace source tree BEFORE the native manager promotes it into its cache.
 *
 * The native `addMarketplace`/`updateMarketplace` path renames the fetched clone into
 * `<marketplacesCacheDir>/<catalog.name>/` and then writes the catalog content to
 * `<...>/marketplace.json` in place. If the source ships `marketplace.json` as a symlink, the clone
 * preserves the link and that write follows it, overwriting whatever path it points at. A symlinked
 * catalog, or any symlink escaping the tree, is therefore a hard blocker. Only the pre-promotion
 * snapshot can catch this; auditing after the add is too late.
 */
export async function auditMarketplaceSource(root: string): Promise<{ blockers: string[]; warnings: string[] }> {
	const audit = await auditSymlinks(root);
	const blockers = [...audit.blockers];
	for (const relative of MARKETPLACE_CATALOG_FILES) {
		let stats;
		try {
			stats = await fsp.lstat(path.join(root, relative));
		} catch {
			continue;
		}
		if (stats.isSymbolicLink()) {
			blockers.push(`Marketplace catalog is a symlink (${relative}): the native add would write through it.`);
		}
	}
	return { blockers, warnings: audit.warnings };
}

export interface RuntimeScopePaths {
	/** Scope label used in messages. */
	scope: string;
	/** Runtime root for the scope: `dirname(<scope installed registry path>)`. */
	runtimeRoot: string;
	/** Plugin cache directory that OMP-managed runtime links point into. */
	pluginsCacheDir: string;
}

/**
 * Guard the runtime destination OMP overwrites when it registers an installed plugin.
 *
 * The native installer recursively removes `<runtimeRoot>/node_modules/<packageName>` and replaces it
 * with a symlink into the plugin cache. It validates only registry and config *names*, never the
 * filesystem, so an unmanaged directory — or a hoisted transitive dependency — at that path is
 * silently destroyed on an ordinary install. This refuses when the destination is occupied by
 * anything other than an OMP-managed link into the plugin cache, or when a scope ancestor is a
 * symlink (which could redirect the removal elsewhere).
 */
export async function auditRuntimeDestinations(
	packageName: string,
	scopes: readonly RuntimeScopePaths[],
): Promise<string[]> {
	const blockers: string[] = [];
	const segments = packageName.split("/");
	const scoped = segments.length === 2 && segments[0].startsWith("@");
	if (
		(!scoped && segments.length !== 1) ||
		segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))
	) {
		blockers.push(`Runtime package name ${JSON.stringify(packageName)} is not a valid package path.`);
		return blockers;
	}
	for (const { scope, runtimeRoot, pluginsCacheDir } of scopes) {
		const nodeModules = path.join(runtimeRoot, "node_modules");
		const linkPath = path.join(nodeModules, ...segments);
		if (!within(nodeModules, linkPath)) {
			blockers.push(`Runtime package name "${packageName}" escapes node_modules in the ${scope} scope.`);
			continue;
		}
		// A scoped package is created under node_modules/@scope, which must be a real directory as well.
		const ancestors = [runtimeRoot, nodeModules, ...(scoped ? [path.join(nodeModules, segments[0])] : [])];
		for (const ancestor of ancestors) {
			try {
				if ((await fsp.lstat(ancestor)).isSymbolicLink()) {
					blockers.push(`Runtime ancestor is a symlink in the ${scope} scope: ${ancestor}`);
				}
			} catch {
				// A missing ancestor is fine: the installer creates it.
			}
		}
		let target: string;
		try {
			const link = await fsp.lstat(linkPath);
			if (!link.isSymbolicLink()) {
				blockers.push(`Runtime destination is occupied by an unmanaged ${link.isDirectory() ? "directory" : "file"}: ${linkPath}`);
				continue;
			}
			target = await fsp.realpath(linkPath);
		} catch (error) {
			if (error instanceof Error && "code" in error && Reflect.get(error, "code") === "ENOENT") continue;
			blockers.push(`Runtime destination cannot be inspected in the ${scope} scope: ${linkPath}`);
			continue;
		}
		const cacheDir = await fsp.realpath(pluginsCacheDir).catch(() => path.resolve(pluginsCacheDir));
		if (!within(cacheDir, target)) {
			blockers.push(`Runtime destination is a symlink outside the plugin cache in the ${scope} scope: ${linkPath} -> ${target}`);
		}
	}
	return blockers;
}

/**
 * Audit the payload OMP actually installed and compare it with the audited source.
 *
 * The inspector and the installer read separate copies: for remote sources the installer fetches
 * the source again, so a clean preview does not prove the installed bytes are clean. This check runs
 * after install. `ok` is false when the installed tree has hard blockers, when its content differs
 * from the audited source, or when either tree could not be fingerprinted.
 */
export async function verifyInstalledPayload(installPath: string, expected: CompatibilityReport): Promise<PayloadVerification> {
	const report = await inspectPluginDirectory(installPath);
	const problems = [...report.blockers];
	if (expected.treeDigest === undefined || report.treeDigest === undefined) {
		problems.push("Content could not be fingerprinted; the installed copy is not proven to match the audited source.");
	} else if (expected.treeDigest !== report.treeDigest) {
		problems.push("Installed content differs from the audited source (the source changed between inspection and install).");
	}
	return { ok: problems.length === 0, report, problems };
}

/* -------------------------------------------------------------------------- */
/*                         Confirm-then-install flow                          */
/* -------------------------------------------------------------------------- */

/** The subset of OMP's `MarketplaceManager` this module needs. Kept structural for tests. */
export interface MarketplaceManagerLike {
	listMarketplaces(): Promise<ReadonlyArray<{ name: string; sourceUri: string }>>;
	addMarketplace(source: string): Promise<{ name: string }>;
	removeMarketplace(name: string): Promise<void>;
	updateMarketplace(name: string): Promise<{ name: string }>;
	listAvailablePlugins(marketplace?: string): Promise<ReadonlyArray<{ name: string; version?: string; description?: string }>>;
	getPluginInfo(name: string, marketplace: string): Promise<{ name: string; version?: string; description?: string } | null>;
	listInstalledPlugins(): Promise<
		ReadonlyArray<{
			id: string;
			scope: string;
			entries: ReadonlyArray<{ installPath: string; version: string; scope: string; enabled?: boolean }>;
			shadowedBy?: string;
		}>
	>;
	validateInstallPlugin(name: string, marketplace: string, options?: { force?: boolean; scope?: InstallScope }): Promise<void>;
	/** Used to roll back a plugin whose installed payload failed verification. */
	uninstallPlugin?(pluginId: string, scope?: InstallScope): Promise<void>;
	installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: InstallScope },
	): Promise<{ installPath: string; version: string; scope: string; enabled?: boolean }>;
}

export interface InstallRequest {
	manager: MarketplaceManagerLike;
	name: string;
	marketplace: string;
	force?: boolean;
	scope?: InstallScope;
	/** Read-only compatibility probe. Runs before any confirmation or mutation. */
	inspect: () => Promise<{ report: CompatibilityReport; origin?: PluginOrigin }>;
	/** Return false to abort. Called only when the report has no hard blockers. */
	confirm: (summary: string) => Promise<boolean>;
	/**
	 * Install the inspected source. Defaults to the manager's own install.
	 *
	 * Supplied by the caller when the source must be pinned: the native manager re-fetches a remote
	 * source at install time, so a clean inspection would not describe the installed bytes. A pinned
	 * installer feeds the exact audited snapshot instead.
	 */
	install?: (options: { force?: boolean; scope?: InstallScope }) => Promise<{ installPath: string; version: string; scope: string; enabled?: boolean }>;
}

export type InstallStatus = "installed" | "unverified" | "unsafe" | "declined" | "blocked" | "failed";

export interface InstallOutcome {
	status: InstallStatus;
	message: string;
	report: CompatibilityReport;
	entry?: { installPath: string; version: string; scope: string; enabled?: boolean };
	/** Set for `unsafe` and `unverified`: what the post-install check found. */
	problems?: string[];
}

/**
 * Inspect, require confirmation, install through the native manager, then verify the installed copy.
 *
 * Order is deliberate. A report with blockers aborts before the confirmation prompt, so an unsafe
 * source is never offered for install. A declined prompt never reaches the manager. After install,
 * the payload on disk is audited and compared with the source: only a clean, matching payload is
 * reported as installed; anything else is `unsafe` (hard blockers) or `unverified` (drift or no
 * fingerprint), and the caller MUST NOT advertise it as active or reload for it.
 */
export async function installMarketplacePlugin(request: InstallRequest): Promise<InstallOutcome> {
	const pluginId = `${request.name}@${request.marketplace}`;
	/** Undo a published install: the native installer leaves registry, runtime link, and cache behind. */
	const rollback = async (): Promise<string> => {
		if (!request.manager.uninstallPlugin) return ` Remove it with: omp plugin uninstall ${pluginId}`;
		try {
			await request.manager.uninstallPlugin(pluginId, request.scope);
			return " The install was rolled back.";
		} catch (error) {
			return ` Rollback failed (${errorMessage(error)}). Remove it with: omp plugin uninstall ${pluginId}`;
		}
	};
	let report: CompatibilityReport;
	let origin: PluginOrigin | undefined;
	try {
		const inspection = await request.inspect();
		report = inspection.report;
		origin = inspection.origin;
	} catch (error) {
		return {
			status: "failed",
			message: `Could not inspect ${pluginId}: ${errorMessage(error)}`,
			report: { pluginRoot: request.name, supported: [], unsupported: [], ignored: [], warnings: [], blockers: [] },
		};
	}

	if (report.blockers.length > 0) {
		return {
			status: "blocked",
			message: `Refused to install ${pluginId}:\n${report.blockers.map(blocker => `  ! ${blocker}`).join("\n")}`,
			report,
		};
	}

	const approved = await request.confirm(formatPreInstallSummary(pluginId, report, { force: request.force, scope: request.scope, origin }));
	if (!approved) return { status: "declined", message: `Install of ${pluginId} cancelled.`, report };

	let entry: { installPath: string; version: string; scope: string; enabled?: boolean };
	try {
		const installOptions = {
			...(request.force ? { force: true } : {}),
			...(request.scope ? { scope: request.scope } : {}),
		};
		entry = request.install
			? await request.install(installOptions)
			: await request.manager.installPlugin(request.name, request.marketplace, installOptions);
	} catch (error) {
		return { status: "failed", message: `Failed to install ${pluginId}: ${errorMessage(error)}`, report };
	}

	const verification = await verifyInstalledPayload(entry.installPath, report);
	if (verification.report.blockers.length > 0) {
		return {
			status: "unsafe",
			message: [
				`Installed ${pluginId} (${entry.version}) but the installed payload FAILED the safety audit.`,
				...verification.report.blockers.map(blocker => `  ! ${blocker}`),
				"Do not reload." + (await rollback()),
			].join("\n"),
			report,
			entry,
			problems: verification.problems,
		};
	}
	if (!verification.ok) {
		return {
			status: "unverified",
			message: [
				`Installed ${pluginId} (${entry.version}) but could not verify the installed payload.`,
				...verification.problems.map(problem => `  ? ${problem}`),
				`Re-inspect with /claude inspect ${pluginId}.` + (await rollback()),
			].join("\n"),
			report,
			entry,
			problems: verification.problems,
		};
	}

	return { status: "installed", message: `Installed ${pluginId} (${entry.version}); payload verified against the audited source.`, report, entry };
}
