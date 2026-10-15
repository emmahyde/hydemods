/**
 * `/claude` — browse and install Claude marketplace plugins into OMP.
 *
 * This is a thin interactive shell over OMP's native marketplace and installer. All registry
 * reads/writes, source cloning, cache management, and plugin-root cache invalidation are the
 * host's own (`MarketplaceManager`), so this module never keeps a parallel registry and never
 * writes user configuration directly. It adds what the native flow lacks:
 *
 *   1. a read-only compatibility report before install, and
 *   2. an explicit confirmation that names the components OMP will load and the Claude-specific
 *      ones it will skip (see `lib/marketplace-core.ts`).
 *
 * Browse and install never execute plugin scripts or hooks; inspection reads files only.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import {
	clearPluginRootsAndCaches,
	resolveOrDefaultProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/manager";
import {
	addMarketplaceEntry,
	getInstalledPluginsRegistryPath,
	getMarketplaceEntry,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	readMarketplacesRegistry,
	removeMarketplaceEntry,
	writeMarketplacesRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/registry";
import { resolvePluginSource, validatePluginSource } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/source-resolver";
import {
	parsePluginId,
	type MarketplaceCatalogMetadata,
	type MarketplacePluginEntry,
	type MarketplaceRegistryEntry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/types";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	auditMarketplaceSource,
	auditRuntimeDestinations,
	errorMessage,
	formatCompatibilityReport,
	inspectPluginDirectory,
	installMarketplacePlugin,
	parseInstallSpec,
	type CompatibilityReport,
	type InstallScope,
	type PluginOrigin,
	type RuntimeScopePaths,
} from "./marketplace-core";

const OFFICIAL_MARKETPLACE = "anthropics/claude-plugins-official";

const SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
	browse: "Browse marketplaces and plugins interactively",
	add: "Add a marketplace source (owner/repo, git URL, or local path)",
	list: "List configured marketplaces",
	available: "List plugins available in a marketplace",
	install: "Inspect, confirm, and install a plugin (name@marketplace)",
	inspect: "Show a plugin's compatibility report without installing",
	info: "Alias of inspect",
	installed: "List installed marketplace plugins",
	remove: "Remove a marketplace source",
	update: "Re-fetch marketplace catalog(s)",
	help: "Show usage",
};

const SUBCOMMANDS = Object.keys(SUBCOMMAND_DESCRIPTIONS);

const HELP = [
	"/claude — Claude marketplace plugins for OMP",
	"",
	"  /claude                            Browse and install interactively",
	"  /claude add <source>               Add a marketplace (owner/repo, git URL, or ./local)",
	"  /claude list                       List configured marketplaces",
	"  /claude available [marketplace]    List available plugins",
	"  /claude inspect <name@marketplace> Show a compatibility report only (alias: info)",
	"  /claude install <name@marketplace> [--force] [--scope user|project] [--yes]",
	"  /claude installed                  List installed plugins",
	"  /claude remove <marketplace>       Remove a marketplace source",
	"  /claude update [marketplace]       Re-fetch catalog(s)",
	"  /claude help                       Show this help",
	"",
	"Quick start:",
	`  /claude add ${OFFICIAL_MARKETPLACE}`,
	"  /claude install pr-review-toolkit@claude-plugins-official",
	"  /reload-plugins",
	"",
	"Install inspects the plugin source read-only, shows which components OMP will load, and",
	"requires confirmation. Claude-only components (hooks.json, plugin settings, output styles,",
	"themes) are reported and skipped. Nothing runs until you confirm.",
].join("\n");

/* -------------------------------------------------------------------------- */
/*                              Native wiring                                 */
/* -------------------------------------------------------------------------- */

async function createManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

/**
 * Prepare a private source snapshot and inspect it without executing plugin code.
 * Both local copies and remote clones remain pinned through confirmation and installation.
 * The caller must release the snapshot after inspection, cancellation, or installation.
 */
async function inspectPlugin(
	manager: MarketplaceManager,
	name: string,
	marketplace: string,
): Promise<{
	report: CompatibilityReport;
	origin: PluginOrigin;
	packageName: string;
	pluginEntry: MarketplacePluginEntry;
	snapshot: { dir: string; cleanup: () => Promise<void> };
}> {
	const entry: MarketplacePluginEntry | null = await manager.getPluginInfo(name, marketplace);
	if (!entry) {
		throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}". Run: /claude available ${marketplace}`);
	}
	const registryEntry = (await manager.listMarketplaces()).find(candidate => candidate.name === marketplace);
	if (!registryEntry) throw new Error(`Marketplace "${marketplace}" not found. Run: /claude list`);

	// Mirrors MarketplaceManager's own root resolution: local sources live at sourceUri;
	// fetched catalogs live under the marketplaces cache dir, next to catalogPath.
	const clonePath =
		registryEntry.sourceType === "local"
			? path.resolve(registryEntry.sourceUri)
			: path.dirname(path.resolve(registryEntry.catalogPath));
	const origin: PluginOrigin = registryEntry.sourceType === "local" ? "local" : "remote";
	let catalogMetadata: MarketplaceCatalogMetadata | undefined;
	try {
		const catalogText = await fsp.readFile(registryEntry.catalogPath, "utf8");
		catalogMetadata = parseMarketplaceCatalog(catalogText, registryEntry.catalogPath).metadata;
	} catch {
		// A missing/unreadable catalog surfaces from getPluginInfo or the manager's own validation.
	}

	const context = { marketplaceClonePath: clonePath, catalogMetadata };
	const localDirectory = await validatePluginSource(entry, context);
	if (localDirectory) {
		// Copy the user's directory now: the tree inspected and confirmed must be the tree installed.
		const copyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hydemods-marketplace-local-"));
		const copy = path.join(copyRoot, "plugin");
		try {
			await fsp.cp(localDirectory, copy, { recursive: true });
			await materializeEmbeddedConfig(copy, entry);
			return {
				report: await inspectPluginDirectory(copy),
				origin,
				packageName: await resolveRuntimePackageName(copy, name),
				pluginEntry: entry,
				snapshot: {
					dir: copy,
					cleanup: async () => { await fsp.rm(copyRoot, { recursive: true, force: true }).catch(() => {}); },
				},
			};
		} catch (error) {
			await fsp.rm(copyRoot, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}

	const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hydemods-marketplace-"));
	let handedOff = false;
	try {
		const resolved = await resolvePluginSource(entry, { ...context, tmpDir: tempRoot });
		await materializeEmbeddedConfig(resolved.dir, entry);
		const report = await inspectPluginDirectory(resolved.dir);
		handedOff = true;
		return {
			report,
			origin,
			packageName: await resolveRuntimePackageName(resolved.dir, name),
			pluginEntry: entry,
			snapshot: {
				dir: resolved.dir,
				// The clone outlives inspection so the install can read exactly the audited bytes.
				cleanup: async () => {
					await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
				},
			},
		};
	} finally {
		if (!handedOff) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
	}
}

/** Invalidate the host's plugin-root caches so `/reload-plugins` (or the next discovery) sees the change. */
async function invalidatePluginCaches(ctx: ExtensionCommandContext): Promise<void> {
	const projectRegistryPath = await resolveOrDefaultProjectRegistryPath(ctx.cwd);
	clearPluginRootsAndCaches(projectRegistryPath ? [projectRegistryPath] : undefined);
}

/* -------------------------------------------------------------------------- */
/*                                Output                                      */
/* -------------------------------------------------------------------------- */

function output(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: "hydemods-marketplace", display: true, content: text }, { triggerTurn: false });
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

/* -------------------------------------------------------------------------- */
/*                                 Commands                                   */
/* -------------------------------------------------------------------------- */

async function browse(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const manager = await createManager(ctx.cwd);
	let marketplaces = await manager.listMarketplaces();
	if (marketplaces.length === 0) {
		const addOfficial = await ctx.ui.confirm(
			"No marketplaces configured",
			`Add the official Claude marketplace (${OFFICIAL_MARKETPLACE})?`,
		);
		if (!addOfficial) {
			output(pi, `Browse cancelled. Add a marketplace with: /claude add ${OFFICIAL_MARKETPLACE}`);
			return;
		}
		const added = await safeAddMarketplace(OFFICIAL_MARKETPLACE);
		notify(ctx, `Added marketplace: ${added.name}`, "info");
		marketplaces = await manager.listMarketplaces();
	}

	const single = marketplaces.length === 1 ? marketplaces[0] : undefined;
	const marketplaceName =
		single?.name ??
		(await ctx.ui.select(
			"Marketplace",
			marketplaces.map(entry => ({ label: entry.name, description: entry.sourceUri })),
		));
	if (!marketplaceName) return;

	const plugins = await manager.listAvailablePlugins(marketplaceName);
	if (plugins.length === 0) {
		output(pi, `No plugins available in ${marketplaceName}.`);
		return;
	}
	const pluginName = await ctx.ui.select(
		`Plugin in ${marketplaceName}`,
		plugins.map(plugin => ({
			label: plugin.name,
			description: [plugin.version ? `v${plugin.version}` : undefined, plugin.description].filter(Boolean).join(" — "),
		})),
	);
	if (!pluginName) return;

	await runInstall(pi, ctx, manager, pluginName, marketplaceName, { force: false, assumeYes: false });
}

interface InstallFlowOptions {
	force: boolean;
	scope?: InstallScope;
	assumeYes: boolean;
}

async function runInstall(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	manager: MarketplaceManager,
	name: string,
	marketplace: string,
	options: InstallFlowOptions,
): Promise<void> {
	let snapshot: { dir: string; cleanup: () => Promise<void> } | undefined;
	let pluginEntry: MarketplacePluginEntry | undefined;
	const outcome = await installMarketplacePlugin({
		manager,
		name,
		marketplace,
		...(options.force ? { force: true } : {}),
		...(options.scope ? { scope: options.scope } : {}),
		inspect: async () => {
			const inspection = await inspectPlugin(manager, name, marketplace);
			snapshot = inspection.snapshot;
			pluginEntry = inspection.pluginEntry;
			const blockers = await runtimeDestinationBlockers(ctx, inspection.packageName, options.scope ?? "user");
			return { report: { ...inspection.report, blockers: [...inspection.report.blockers, ...blockers] }, origin: inspection.origin };
		},
		install: async installOptions => {
			if (!snapshot || !pluginEntry) throw new Error("Source snapshot was not resolved before install.");
			return installFromSnapshot(ctx, name, marketplace, pluginEntry, snapshot.dir, installOptions);
		},
		confirm: async summary => {
			if (options.assumeYes) return true;
			if (!ctx.hasUI) return false;
			return ctx.ui.confirm(`Install ${name}@${marketplace}?`, summary);
		},
	});
	await snapshot?.cleanup();

	if (outcome.status === "installed") {
		await invalidatePluginCaches(ctx);
		output(
			pi,
			[
				outcome.message,
				`Components that will load after reload: ${outcome.report.supported.length > 0 ? outcome.report.supported.map(entry => entry.label).join(", ") : "none detected"}`,
				"",
				"Run /reload-plugins to load the plugin's components into this session.",
			].join("\n"),
		);
		notify(ctx, `Installed ${name}@${marketplace}. Run /reload-plugins.`, "info");
		return;
	}

	output(pi, outcome.message);
	if (outcome.status === "declined") return;
	notify(
		ctx,
		outcome.message.split("\n")[0] ?? outcome.message,
		outcome.status === "blocked" || outcome.status === "unsafe" || outcome.status === "unverified" ? "warning" : "error",
	);
}

/**
 * Package name OMP will register at runtime: the plugin's `package.json` name, else the plugin name.
 * Mirrors the native resolver, which reads the same field from the resolved source directory.
 */
async function resolveRuntimePackageName(sourceDir: string, fallback: string): Promise<string> {
	const text = await fsp.readFile(path.join(sourceDir, "package.json"), "utf8").catch(() => undefined);
	if (text === undefined) return fallback;
	try {
		const parsed: unknown = JSON.parse(text);
		const declared = parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "name") : undefined;
		return typeof declared === "string" && declared.length > 0 ? declared : fallback;
	} catch {
		return fallback;
	}
}

/** Installed registry path per scope, exactly as the native manager's options receive it. */
async function installedRegistryPathFor(scope: InstallScope, ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (scope === "user") return getInstalledPluginsRegistryPath();
	return resolveOrDefaultProjectRegistryPath(ctx.cwd);
}

/**
 * Blockers for the runtime destination of a plugin about to be installed.
 *
 * Covers the target scope and the other scope, because a forced reinstall can rename the runtime key
 * in both. The install is refused before confirmation when an unmanaged entry occupies the path.
 */
async function runtimeDestinationBlockers(ctx: ExtensionCommandContext, packageName: string, scope: InstallScope): Promise<string[]> {
	const pluginsCacheDir = getPluginsCacheDir();
	const otherScope: InstallScope = scope === "user" ? "project" : "user";
	const scopes: RuntimeScopePaths[] = [];
	for (const candidate of [scope, otherScope] as const) {
		const registryPath = await installedRegistryPathFor(candidate, ctx);
		if (registryPath) scopes.push({ scope: candidate, runtimeRoot: path.dirname(registryPath), pluginsCacheDir });
	}
	return auditRuntimeDestinations(packageName, scopes);
}

/**
 * Materialize the embedded LSP/DAP config files the native installer will generate, BEFORE inspection.
 *
 * The installer writes these from the marketplace catalog entry, not from the plugin tree, so a
 * skills-only plugin can silently gain executable server config the inspector never saw. Writing them
 * here makes the inspector classify them (so the confirmation names them) and makes the payload
 * fingerprint cover their exact bytes. Any pre-existing path is removed first, so a symlink shipped by
 * the source is replaced rather than followed.
 */
async function materializeEmbeddedConfig(pluginDir: string, entry: MarketplacePluginEntry): Promise<void> {
	const root = path.resolve(pluginDir);
	const audit = await auditMarketplaceSource(root);
	if (audit.blockers.length) {
		throw new Error(`Refusing unsafe plugin source:\n${audit.blockers.join("\n")}`);
	}
	const readReferenced = async (relative: string): Promise<string> => {
		const full = path.resolve(root, relative);
		const relativePath = path.relative(root, full);
		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			throw new Error(`Embedded config path declared by the catalog escapes the plugin: ${relative}`);
		}
		const realRoot = await fsp.realpath(root);
		const realFile = await fsp.realpath(full);
		const realRelative = path.relative(realRoot, realFile);
		if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
			throw new Error(`Embedded config link escapes the plugin: ${relative}`);
		}
		return await fsp.readFile(realFile, "utf8");
	};
	const emit = async (relative: string, content: string): Promise<void> => {
		const target = path.join(root, relative);
		await fsp.rm(target, { force: true });
		await fsp.writeFile(target, content, { flag: "wx" });
	};
	const lsp = Reflect.get(entry, "lspServers");
	if (typeof lsp === "string") await emit(".lsp.json", await readReferenced(lsp));
	else if (lsp !== undefined && lsp !== null) await emit(".lsp.json", `${JSON.stringify({ servers: lsp }, null, 2)}\n`);
	const dap = Reflect.get(entry, "dapAdapters");
	if (typeof dap === "string") {
		const extension = path.extname(dap).toLowerCase();
		await emit(extension === ".yaml" || extension === ".yml" ? `.dap${extension}` : ".dap.json", await readReferenced(dap));
	} else if (dap !== undefined && dap !== null) {
		await emit(".dap.json", `${JSON.stringify({ adapters: dap }, null, 2)}\n`);
	}
}

/**
 * Install an audited snapshot through the native manager without letting it re-fetch the source.
 *
 * The native manager resolves a remote plugin source itself, so the bytes it installs would come from
 * a second fetch that no inspection ever saw — an attacker can add a symlinked `.lsp.json` in that
 * window and the manager's embedded-config write follows it. Here a shadow marketplace (same name, so
 * identity is preserved) points the plugin source at a private copy of the audited tree, and the
 * installer runs against real installed registries, real plugin cache, and the real runtime root. Both
 * the shadow catalog and the copy are private, so no third party can change them between audit and
 * install.
 */
async function installFromSnapshot(
	ctx: ExtensionCommandContext,
	pluginName: string,
	marketplaceName: string,
	entry: MarketplacePluginEntry,
	sourceDir: string,
	options: { force?: boolean; scope?: InstallScope },
): Promise<{ installPath: string; version: string; scope: string; enabled?: boolean }> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "hydemods-marketplace-pin-"));
	try {
		const marketplacesDir = path.join(root, "marketplaces");
		const cloneDir = path.join(marketplacesDir, marketplaceName);
		const pinnedDir = path.join(cloneDir, "pinned-plugin");
		await fsp.mkdir(cloneDir, { recursive: true });
		await fsp.cp(sourceDir, pinnedDir, { recursive: true });

		// Re-audit the exact bytes the installer will read, in the private directory it will read them from.
		const audit = await auditMarketplaceSource(pinnedDir);
		if (audit.blockers.length > 0) {
			throw new Error(
				`Refusing to install ${pluginName}@${marketplaceName}:\n${audit.blockers.map(blocker => `  ! ${blocker}`).join("\n")}`,
			);
		}

		const catalogPath = path.join(cloneDir, "marketplace.json");
		const catalog = {
			name: marketplaceName,
			owner: { name: "hydemods" },
			// The original entry keeps version and inline lsp/dap declarations; only the source is pinned.
			plugins: [{ ...entry, source: "./pinned-plugin" }],
		};
		await fsp.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });

		// Reuse the real registry's shape (the marketplaces registry is version 1) and the real entry,
		// overriding only the source location, so the install resolves the pinned copy under the
		// marketplace's own identity.
		const registryPath = path.join(root, "shadow-marketplaces.json");
		const realRegistry = await readMarketplacesRegistry(getMarketplacesRegistryPath());
		const realEntry = getMarketplaceEntry(realRegistry, marketplaceName);
		const now = new Date().toISOString();
		const base = realEntry ?? {
			name: marketplaceName,
			sourceType: "local" as const,
			sourceUri: cloneDir,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};
		const shadowRegistry = {
			version: realRegistry.version,
			marketplaces: [{ ...base, name: marketplaceName, sourceType: "local" as const, sourceUri: cloneDir, catalogPath, updatedAt: now }],
		};
		await fsp.writeFile(registryPath, `${JSON.stringify(shadowRegistry, null, 2)}\n`, { flag: "wx" });

		const pinned = new MarketplaceManager({
			marketplacesRegistryPath: registryPath,
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(ctx.cwd),
			marketplacesCacheDir: marketplacesDir,
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
		return await pinned.installPlugin(pluginName, marketplaceName, options);
	} finally {
		await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Persist a marketplace catalog without following a symlink.
 *
 * The native add/update writes `<cacheDir>/<name>/marketplace.json` in place, so a symlinked catalog
 * shipped by the source redirects that write to an arbitrary path. This sanitizes the directory and
 * swaps the catalog in with a same-directory rename, which replaces the link itself, not its target.
 */
async function persistMarketplaceCatalog(cacheDir: string, name: string, catalog: unknown): Promise<string> {
	const dir = path.join(cacheDir, name);
	try {
		const stats = await fsp.lstat(dir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) await fsp.rm(dir, { recursive: true, force: true });
	} catch {
		// The directory does not exist yet.
	}
	await fsp.mkdir(dir, { recursive: true });
	const target = path.join(dir, "marketplace.json");
	const tmp = path.join(dir, `.marketplace-${randomUUID()}.tmp`);
	// "wx" fails rather than following a pre-existing path, so a planted temp-name symlink cannot redirect this write.
	await fsp.writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
	try {
		await fsp.rename(tmp, target);
	} catch {
		// Windows cannot rename over an existing file. Removing the link first still avoids traversal.
		await fsp.rm(target, { force: true });
		await fsp.rename(tmp, target);
	}
	return target;
}

/**
 * Add a marketplace with a safe catalog write, retaining native registry state.
 *
 * Same registry file, same entry shape, and the native clone/promote helpers, so plugins installed
 * from this marketplace stay discoverable. Only the catalog persistence differs: this audits the
 * fetched snapshot and never writes through a symlink.
 */
async function safeAddMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
	const registryPath = getMarketplacesRegistryPath();
	const cacheDir = getMarketplacesCacheDir();
	const registry = await readMarketplacesRegistry(registryPath);
	const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hydemods-marketplace-add-"));
	try {
		const { catalog, clonePath } = await fetchMarketplace(source, tmpRoot);
		if (registry.marketplaces.some(entry => entry.name.toLowerCase() === catalog.name.toLowerCase())) {
			throw new Error(`Marketplace "${catalog.name}" already exists.`);
		}
		if (clonePath) {
			const audit = await auditMarketplaceSource(clonePath);
			if (audit.blockers.length > 0) {
				throw new Error(`Refusing to add ${source}:\n${audit.blockers.map(blocker => `  ! ${blocker}`).join("\n")}`);
			}
			await promoteCloneToCache(clonePath, cacheDir, catalog.name);
		}
		const catalogPath = await persistMarketplaceCatalog(cacheDir, catalog.name, catalog);
		const sourceType = classifySource(source);
		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: sourceType === "local" ? path.resolve(source) : source,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};
		await writeMarketplacesRegistry(registryPath, addMarketplaceEntry(registry, entry));
		return entry;
	} finally {
		await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	}
}

/** Re-fetch, audit, and re-register a marketplace; returns undefined when it is not registered. */
async function safeUpdateMarketplace(name: string): Promise<MarketplaceRegistryEntry | undefined> {
	const registryPath = getMarketplacesRegistryPath();
	const cacheDir = getMarketplacesCacheDir();
	const registry = await readMarketplacesRegistry(registryPath);
	const existing = getMarketplaceEntry(registry, name);
	if (!existing) return undefined;
	const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "hydemods-marketplace-update-"));
	try {
		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, tmpRoot);
		if (catalog.name !== existing.name) {
			throw new Error(`Marketplace "${existing.name}" now declares the name "${catalog.name}"; refusing to rename it.`);
		}
		if (clonePath) {
			const audit = await auditMarketplaceSource(clonePath);
			if (audit.blockers.length > 0) {
				throw new Error(`Refusing to update ${existing.name}:\n${audit.blockers.map(blocker => `  ! ${blocker}`).join("\n")}`);
			}
			await promoteCloneToCache(clonePath, cacheDir, existing.name);
		}
		const catalogPath = await persistMarketplaceCatalog(cacheDir, existing.name, catalog);
		const updated: MarketplaceRegistryEntry = { ...existing, catalogPath, updatedAt: new Date().toISOString() };
		await writeMarketplacesRegistry(registryPath, addMarketplaceEntry(removeMarketplaceEntry(registry, existing.name), updated));
		return updated;
	} finally {
		await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	}
}

/** Update every registered marketplace; per-marketplace failures are reported, not fatal. */
async function safeUpdateAllMarketplaces(): Promise<{ updated: number; failures: string[] }> {
	const registry = await readMarketplacesRegistry(getMarketplacesRegistryPath());
	const failures: string[] = [];
	let updated = 0;
	for (const entry of registry.marketplaces) {
		try {
			await safeUpdateMarketplace(entry.name);
			updated += 1;
		} catch (error) {
			failures.push(`${entry.name}: ${errorMessage(error)}`);
		}
	}
	return { updated, failures };
}

async function addMarketplace(pi: ExtensionAPI, source: string): Promise<void> {
	if (!source) {
		output(pi, `Usage: /claude add <owner/repo | git-url | ./local-path>\nExample: /claude add ${OFFICIAL_MARKETPLACE}`);
		return;
	}
	try {
		classifySource(source);
	} catch (error) {
		output(pi, `${errorMessage(error)}\nExamples:\n  /claude add ${OFFICIAL_MARKETPLACE}\n  /claude add https://github.com/owner/repo\n  /claude add ./my-marketplace`);
		return;
	}
	let entry: MarketplaceRegistryEntry;
	try {
		entry = await safeAddMarketplace(source);
	} catch (error) {
		output(pi, errorMessage(error));
		return;
	}
	output(pi, `Added marketplace: ${entry.name}\n  source: ${entry.sourceUri}\n\nBrowse with /claude available ${entry.name}`);
}

async function installCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, argText: string): Promise<void> {
	const parsed = parseInstallSpec(argText, { allowYes: true });
	if (!parsed.ok) {
		output(pi, parsed.error);
		return;
	}
	const { pluginId, scope, assumeYes } = parsed.value;
	if (!ctx.hasUI && !assumeYes) {
		output(
			pi,
			`Refusing to install without confirmation in a non-interactive session.\nRe-run with --yes after reviewing: /claude inspect ${pluginId}`,
		);
		return;
	}
	const pluginRef = parsePluginId(pluginId);
	if (!pluginRef) {
		output(pi, `Invalid plugin id "${pluginId}".`);
		return;
	}

	const manager = await createManager(ctx.cwd);
	let force = parsed.value.force;
	const alreadyInstalled = (await manager.listInstalledPlugins()).some(entry => entry.id === pluginId);
	if (alreadyInstalled && !force) {
		if (!ctx.hasUI) {
			output(pi, `${pluginId} is already installed. Pass --force to reinstall.`);
			return;
		}
		force = await ctx.ui.confirm("Already installed", `${pluginId} is already installed. Reinstall (force)?`);
		if (!force) {
			output(pi, "Cancelled.");
			return;
		}
	}

	await runInstall(pi, ctx, manager, pluginRef.name, pluginRef.marketplace, {
		force,
		...(scope ? { scope } : {}),
		assumeYes,
	});
}

async function inspectCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, argText: string): Promise<void> {
	const parsed = parseInstallSpec(argText);
	if (!parsed.ok) {
		output(pi, parsed.error);
		return;
	}
	const pluginRef = parsePluginId(parsed.value.pluginId);
	if (!pluginRef) {
		output(pi, `Invalid plugin id "${parsed.value.pluginId}".`);
		return;
	}
	const manager = await createManager(ctx.cwd);
	try {
		const inspected = await inspectPlugin(manager, pluginRef.name, pluginRef.marketplace);
		try {
			output(pi, `Plugin: ${parsed.value.pluginId}\nSource: ${JSON.stringify(inspected.pluginEntry.source)}\n${formatCompatibilityReport(inspected.report)}`);
		} finally {
			await inspected.snapshot.cleanup();
		}
	} catch (error) {
		output(pi, `Could not inspect ${parsed.value.pluginId}: ${errorMessage(error)}`);
	}
}

async function run(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	const verb = tokens[0] ?? "";
	const rest = tokens.slice(1);
	const argText = rest.join(" ");

	if (verb === "" || verb === "browse") {
		if (!ctx.hasUI) {
			output(pi, `Interactive browse needs the TUI. Use:\n  /claude available [marketplace]\n  /claude install <name@marketplace>`);
			return;
		}
		await browse(pi, ctx);
		return;
	}

	switch (verb) {
		case "help":
			output(pi, HELP);
			return;
		case "list": {
			const manager = await createManager(ctx.cwd);
			const marketplaces = await manager.listMarketplaces();
			output(
				pi,
				marketplaces.length === 0
					? `No marketplaces configured. Try: /claude add ${OFFICIAL_MARKETPLACE}`
					: ["Marketplaces:", ...marketplaces.map(entry => `  ${entry.name}  [${entry.sourceType}]  ${entry.sourceUri}`)].join("\n"),
			);
			return;
		}
		case "available": {
			const manager = await createManager(ctx.cwd);
			const names = rest[0] ? [rest[0]] : (await manager.listMarketplaces()).map(entry => entry.name);
			const rows: string[] = [];
			for (const name of names) {
				for (const plugin of await manager.listAvailablePlugins(name)) {
					rows.push(`  ${plugin.name}@${name}${plugin.version ? `  v${plugin.version}` : ""}${plugin.description ? ` — ${plugin.description}` : ""}`);
				}
			}
			output(pi, rows.length ? ["Available plugins:", ...rows].join("\n") : "No plugins available.");
			return;
		}
		case "installed": {
			const manager = await createManager(ctx.cwd);
			const installed = await manager.listInstalledPlugins();
			output(
				pi,
				installed.length === 0
					? "No marketplace plugins installed."
					: [
							"Installed plugins:",
							...installed.map(
								entry =>
									`  ${entry.id}  [${entry.scope}]${entry.shadowedBy ? " (shadowed by project)" : ""}  ${entry.entries[0]?.version ?? "?"}`,
							),
						].join("\n"),
			);
			return;
		}
		case "add":
			await addMarketplace(pi, argText);
			return;
		case "remove":
		case "rm": {
			const name = rest[0];
			if (!name) {
				output(pi, "Usage: /claude remove <marketplace>");
				return;
			}
			const manager = await createManager(ctx.cwd);
			await manager.removeMarketplace(name);
			output(pi, `Removed marketplace: ${name}`);
			return;
		}
		case "update": {
			const target = rest[0];
			try {
				if (target) {
					const updated = await safeUpdateMarketplace(target);
					if (!updated) {
						output(pi, `Marketplace "${target}" not found. Run: /claude list`);
						return;
					}
					await invalidatePluginCaches(ctx);
					output(pi, `Updated marketplace: ${updated.name}`);
					return;
				}
				const { updated, failures } = await safeUpdateAllMarketplaces();
				await invalidatePluginCaches(ctx);
				output(
					pi,
					[
						`Updated ${updated} marketplace(s).`,
						...(failures.length > 0 ? ["Failures:", ...failures.map(item => `  ! ${item}`)] : []),
					].join("\n"),
				);
			} catch (error) {
				output(pi, `Update failed: ${errorMessage(error)}`);
			}
			return;
		}
		case "inspect":
		case "info":
			await inspectCommand(pi, ctx, argText);
			return;
		case "install":
			await installCommand(pi, ctx, argText);
			return;
		default:
			output(pi, `Unknown subcommand "${verb}".\n\n${HELP}`);
			return;
	}
}

/** One registration per ExtensionAPI: calling `registerMarketplace` twice must not register twice. */
const registeredApis = new WeakSet<ExtensionAPI>();

/**
 * Register the `/claude` command. The name is bare because OMP extension commands are not
 * namespaced, and `marketplace` is reserved by the host's own built-in slash command — an
 * extension registering it would be silently skipped.
 */
export function registerMarketplace(pi: ExtensionAPI): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);
	pi.registerCommand("claude", {
		description: "Browse and install Claude marketplace plugins (inspect + confirm)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const text = prefix.trimStart();
			if (text.includes(" ")) return null;
			const items = SUBCOMMANDS.filter(name => name.startsWith(text.toLowerCase())).map(name => ({
				value: name,
				label: name,
				description: SUBCOMMAND_DESCRIPTIONS[name],
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				await run(pi, args, ctx);
			} catch (error) {
				// Network, git, and registry failures surface here instead of as an unhandled rejection.
				const message = `/claude failed: ${errorMessage(error)}`;
				output(pi, message);
				notify(ctx, message, "error");
			}
		},
	});
}
