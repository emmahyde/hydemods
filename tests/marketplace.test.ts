import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	auditMarketplaceSource,
	auditRuntimeDestinations,
	auditSymlinks,
	formatCompatibilityReport,
	formatPreInstallSummary,
	inspectPluginDirectory,
	installMarketplacePlugin,
	parseInstallSpec,
	verifyInstalledPayload,
	type CompatibilityReport,
	type InstallScope,
	type MarketplaceManagerLike,
} from "../lib/marketplace-core";

const fixtureRoots: string[] = [];
afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create a throwaway plugin tree; keys are relative paths, values are file contents. */
function makeTree(files: Record<string, string>): string {
	const scratch = join(import.meta.dir, "..", ".claude", "scratchpad");
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "marketplace-test-"));
	fixtureRoots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

function emptyReport(overrides: Partial<CompatibilityReport> = {}): CompatibilityReport {
	return { pluginRoot: "/plugins/demo", supported: [], unsupported: [], ignored: [], warnings: [], blockers: [], ...overrides };
}

interface InstallCall {
	name: string;
	marketplace: string;
	options?: { force?: boolean; scope?: InstallScope };
}

function fakeManager(options: { failInstall?: boolean; installPath?: string } = {}): { manager: MarketplaceManagerLike; calls: InstallCall[] } {
	const calls: InstallCall[] = [];
	const manager: MarketplaceManagerLike = {
		listMarketplaces: async () => [],
		addMarketplace: async source => ({ name: source }),
		removeMarketplace: async () => {},
		updateMarketplace: async name => ({ name }),
		listAvailablePlugins: async () => [],
		getPluginInfo: async () => null,
		listInstalledPlugins: async () => [],
		validateInstallPlugin: async () => {},
		installPlugin: async (name, marketplace, installOptions) => {
			calls.push({ name, marketplace, options: installOptions });
			if (options.failInstall) throw new Error("cache write failed");
			return { installPath: options.installPath ?? `/cache/${name}`, version: "1.2.3", scope: installOptions?.scope ?? "user" };
		},
	};
	return { manager, calls };
}

/* -------------------------------------------------------------------------- */

describe("parseInstallSpec", () => {
	test("accepts name@marketplace", () => {
		const parsed = parseInstallSpec("pr-review-toolkit@claude-plugins-official");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.pluginId).toBe("pr-review-toolkit@claude-plugins-official");
		expect(parsed.value.force).toBe(false);
		expect(parsed.value.assumeYes).toBe(false);
		expect(parsed.value.scope).toBeUndefined();
	});

	test("parses --force, --scope, and --yes", () => {
		const parsed = parseInstallSpec("foo@bar --force --scope project --yes", { allowYes: true });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.force).toBe(true);
		expect(parsed.value.scope).toBe("project");
		expect(parsed.value.assumeYes).toBe(true);
	});

	test("parses the --user shorthand", () => {
		const parsed = parseInstallSpec("foo@bar --user");
		expect(parsed.ok && parsed.value.scope).toBe("user");
	});

	test("rejects a missing marketplace segment", () => {
		const parsed = parseInstallSpec("toolkit");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("Invalid plugin id");
	});

	test("rejects a name longer than 64 characters", () => {
		const parsed = parseInstallSpec(`${"a".repeat(65)}@marketplace`);
		expect(parsed.ok).toBe(false);
	});

	test("rejects unknown options", () => {
		const parsed = parseInstallSpec("foo@bar --recursive");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("Unknown option");
	});

	test("rejects --yes when not allowed", () => {
		const parsed = parseInstallSpec("foo@bar --yes");
		expect(parsed.ok).toBe(false);
	});

	test("rejects --scope without a valid value", () => {
		const parsed = parseInstallSpec("foo@bar --scope global");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("--scope");
	});

	test("rejects more than one positional", () => {
		expect(parseInstallSpec("a@b c@d").ok).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */

describe("inspectPluginDirectory", () => {
	test("classifies supported, unsupported, and ignored components", async () => {
		const root = makeTree({
			".claude-plugin/plugin.json": JSON.stringify({ name: "demo" }),
			"skills/review/SKILL.md": "# Review\n",
			"rules/style.md": "Be terse.\n",
			"commands/check.md": "---\ndescription: check\n---\n",
			"hooks/pre/before.sh": "#!/bin/sh\nexit 0\n",
			"tools/hello.ts": "export default {};\n",
			"agents/sleuth.md": "---\nname: sleuth\n---\n",
			".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
			"hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [] } }),
			"output-styles/terse.md": "terse",
			"themes/dark.json": "{}",
			"scripts/helper.sh": "#!/bin/sh\nexit 0\n",
			"marketplace.json": JSON.stringify({ plugins: [] }),
		});

		const report = await inspectPluginDirectory(root);
		const supported = new Set(report.supported.map(entry => entry.kind));
		const unsupported = new Set(report.unsupported.map(entry => entry.kind));
		const ignored = new Set(report.ignored.map(entry => entry.kind));

		expect(report.manifestPath).toBe(".claude-plugin/plugin.json");
		expect(supported).toEqual(new Set(["skills", "rules", "commands", "hooks", "tools", "agents", "mcp"]));
		expect(unsupported).toEqual(new Set(["claude-hooks", "output-styles", "themes"]));
		expect(ignored).toEqual(new Set(["scripts", "marketplace-metadata"]));
		expect(report.blockers).toEqual([]);
	});

	test("reads the OMP-priority manifest name for an escape blocker", async () => {
		const root = makeTree({
			".omp-plugin/plugin.json": JSON.stringify({ skills: "../outside" }),
		});
		const report = await inspectPluginDirectory(root);
		expect(report.blockers.some(blocker => blocker.includes("escapes the plugin root"))).toBe(true);
		expect(report.supported).toEqual([]);
	});

	test("warns on a malformed manifest without throwing", async () => {
		const root = makeTree({ ".claude-plugin/plugin.json": "{ not json" });
		const report = await inspectPluginDirectory(root);
		expect(report.manifestPath).toBeUndefined();
		expect(report.warnings.some(warning => warning.includes("malformed manifest"))).toBe(true);
	});

	test("blocks a missing plugin root", async () => {
		const report = await inspectPluginDirectory(join(makeTree({}), "missing"));
		expect(report.blockers.some(blocker => blocker.includes("not found"))).toBe(true);
	});

	test("blocks a symlink that escapes the plugin root", async () => {
		const root = makeTree({ "skills/demo/SKILL.md": "x" });
		const outside = makeTree({});
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(outside, join(root, "linked-outside"));

		const report = await inspectPluginDirectory(root);
		expect(report.blockers.some(blocker => blocker.includes("Symlink escapes plugin root"))).toBe(true);
	});

	test("never executes plugin scripts or hooks during inspection", async () => {
		const root = makeTree({});
		const marker = join(root, "executed.marker");
		mkdirSync(join(root, "scripts"), { recursive: true });
		mkdirSync(join(root, "hooks"), { recursive: true });
		writeFileSync(join(root, "scripts", "pwn.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
		writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: `touch ${marker}` }] } }));

		const report = await inspectPluginDirectory(root);
		expect(existsSync(marker)).toBe(false);
		expect(report.unsupported.some(entry => entry.kind === "claude-hooks")).toBe(true);
		expect(report.ignored.some(entry => entry.kind === "scripts")).toBe(true);
	});
});

describe("auditSymlinks", () => {
	test("returns no blockers for a clean tree", async () => {
		const root = makeTree({ "skills/a/SKILL.md": "x" });
		const { blockers } = await auditSymlinks(root);
		expect(blockers).toEqual([]);
	});

	test("fails closed when the plugin root cannot be resolved", async () => {
		const { blockers } = await auditSymlinks(join(makeTree({}), "missing"));
		expect(blockers.some(blocker => blocker.includes("Audit inconclusive"))).toBe(true);
	});

	test("blocks a symlink whose target does not exist", async () => {
		const root = makeTree({});
		symlinkSync(join(root, "missing-target"), join(root, "dangling"));
		const { blockers } = await auditSymlinks(root);
		expect(blockers.some(blocker => blocker.includes("Symlink target missing"))).toBe(true);
	});

	test("blocks a dangling .lsp.json symlink that the embedded-config write would create", async () => {
		const root = makeTree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "demo" }) });
		const victim = join(makeTree({}), "created-by-installer.json");
		symlinkSync(victim, join(root, ".lsp.json"));
		const report = await inspectPluginDirectory(root);
		expect(report.blockers.some(blocker => blocker.includes(".lsp.json"))).toBe(true);
		expect(existsSync(victim)).toBe(false);
	});
	test("reports embedded .lsp.json and .dap.json as supported", async () => {
		const root = makeTree({
			".claude-plugin/plugin.json": JSON.stringify({ name: "demo" }),
			".lsp.json": JSON.stringify({ servers: {} }),
			".dap.json": JSON.stringify({ adapters: {} }),
		});
		const report = await inspectPluginDirectory(root);
		const supported = new Set(report.supported.map(entry => entry.kind));
		expect(supported.has("lsp")).toBe(true);
		expect(supported.has("dap")).toBe(true);
	});
});

describe("auditMarketplaceSource", () => {
	test("blocks a marketplace.json symlink the native add would write through", async () => {
		const root = makeTree({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "m" }) });
		const outside = makeTree({});
		symlinkSync(join(outside, "victim.json"), join(root, "marketplace.json"));
		const { blockers } = await auditMarketplaceSource(root);
		expect(blockers.some(blocker => blocker.includes("Marketplace catalog is a symlink"))).toBe(true);
	});

	test("accepts a clean marketplace tree", async () => {
		const root = makeTree({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "m" }) });
		const { blockers } = await auditMarketplaceSource(root);
		expect(blockers).toEqual([]);
	});
});

describe("auditRuntimeDestinations", () => {
	test("blocks an unmanaged directory at the runtime destination", async () => {
		const runtimeRoot = makeTree({ "node_modules/hand-rolled/package.json": "{}" });
		const blockers = await auditRuntimeDestinations("hand-rolled", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("unmanaged directory"))).toBe(true);
	});

	test("blocks a symlinked node_modules parent", async () => {
		const runtimeRoot = makeTree({});
		const elsewhere = makeTree({});
		symlinkSync(elsewhere, join(runtimeRoot, "node_modules"));
		const blockers = await auditRuntimeDestinations("demo", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("Runtime ancestor is a symlink"))).toBe(true);
	});

	test("blocks a runtime destination symlinked outside the plugin cache", async () => {
		const runtimeRoot = makeTree({});
		const outside = makeTree({});
		mkdirSync(join(runtimeRoot, "node_modules"), { recursive: true });
		symlinkSync(outside, join(runtimeRoot, "node_modules", "demo"));
		const blockers = await auditRuntimeDestinations("demo", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("outside the plugin cache"))).toBe(true);
	});

	test("accepts a missing destination and an OMP-managed link into the plugin cache", async () => {
		const runtimeRoot = makeTree({});
		const pluginsCacheDir = makeTree({ "demo@1.0.0/package.json": "{}" });
		expect(await auditRuntimeDestinations("demo", [{ scope: "user", runtimeRoot, pluginsCacheDir }])).toEqual([]);
		mkdirSync(join(runtimeRoot, "node_modules"), { recursive: true });
		symlinkSync(join(pluginsCacheDir, "demo@1.0.0"), join(runtimeRoot, "node_modules", "demo"));
		expect(await auditRuntimeDestinations("demo", [{ scope: "user", runtimeRoot, pluginsCacheDir }])).toEqual([]);
	});

	test("rejects a package name that is not a valid package path", async () => {
		const runtimeRoot = makeTree({});
		const blockers = await auditRuntimeDestinations("../../etc", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("is not a valid package path"))).toBe(true);
	});

	test("accepts a scoped package destination when it is clean", async () => {
		const runtimeRoot = makeTree({});
		const blockers = await auditRuntimeDestinations("@scope/demo", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers).toEqual([]);
	});

	test("blocks a scoped package when node_modules/@scope is a symlink", async () => {
		const runtimeRoot = makeTree({});
		const elsewhere = makeTree({});
		mkdirSync(join(runtimeRoot, "node_modules"), { recursive: true });
		symlinkSync(elsewhere, join(runtimeRoot, "node_modules", "@scope"));
		const blockers = await auditRuntimeDestinations("@scope/demo", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("Runtime ancestor is a symlink"))).toBe(true);
	});

	test("rejects a two-segment name that is not scoped", async () => {
		const runtimeRoot = makeTree({});
		const blockers = await auditRuntimeDestinations("a/b", [
			{ scope: "user", runtimeRoot, pluginsCacheDir: join(runtimeRoot, "plugins") },
		]);
		expect(blockers.some(blocker => blocker.includes("is not a valid package path"))).toBe(true);
	});
});

describe("verifyInstalledPayload", () => {
	test("matches when both trees carry the same embedded config", async () => {
		const embedded = '{"servers":{"ts":{"command":"tsc"}}}\n';
		const audited = makeTree({ "skills/a/SKILL.md": "x", ".lsp.json": embedded });
		const installed = makeTree({ "skills/a/SKILL.md": "x", ".lsp.json": embedded });
		const report = await inspectPluginDirectory(audited);
		const verification = await verifyInstalledPayload(installed, report);
		expect(verification.problems).toEqual([]);
		expect(verification.ok).toBe(true);
	});

	test("flags embedded config the audited snapshot did not have", async () => {
		const audited = makeTree({ "skills/a/SKILL.md": "x" });
		const installed = makeTree({ "skills/a/SKILL.md": "x", ".lsp.json": '{"servers":{}}' });
		const report = await inspectPluginDirectory(audited);
		const verification = await verifyInstalledPayload(installed, report);
		expect(verification.ok).toBe(false);
		expect(verification.problems.some(problem => problem.includes("differs"))).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

describe("formatting", () => {
	test("labels each bucket", () => {
		const report = emptyReport({
			supported: [{ kind: "skills", label: "Skills", status: "supported", count: 1, paths: ["skills/a/"] }],
			unsupported: [{ kind: "claude-hooks", label: "Claude hook config", status: "unsupported", count: 1, paths: ["hooks/hooks.json"] }],
		});
		const text = formatCompatibilityReport(report);
		expect(text).toContain("Supported (loaded by OMP):");
		expect(text).toContain("Unsupported (Claude-specific, skipped):");
		expect(text).toContain("Claude hook config");
	});

	test("pre-install summary counts supported components and names unsupported ones", () => {
		const report = emptyReport({
			supported: [{ kind: "commands", label: "Slash commands", status: "supported", count: 2, paths: ["a.md", "b.md"] }],
			unsupported: [{ kind: "themes", label: "Themes", status: "unsupported", count: 1, paths: ["themes"] }],
		});
		const text = formatPreInstallSummary("demo@market", report, { force: true, scope: "user" });
		expect(text).toContain("Components OMP will load: 2");
		expect(text).toContain("Unsupported components skipped: Themes");
		expect(text).toContain("--force");
		expect(text).toContain("Scope: user");
		expect(text).toContain("Nothing is loaded until you run /reload-plugins.");
	});

	test("discloses executable components, pinned remote content, and the default scope", () => {
		const report = emptyReport({
			supported: [
				{ kind: "tools", label: "Tools", status: "supported", count: 1, paths: ["tools/a.ts"] },
				{ kind: "mcp", label: "MCP servers", status: "supported", count: 1, paths: [".mcp.json"] },
				{ kind: "skills", label: "Skills", status: "supported", count: 1, paths: ["skills/a/"] },
			],
		});
		const text = formatPreInstallSummary("demo@market", report, { origin: "remote" });
		expect(text).toContain("run code or launch processes: Tools, MCP servers");
		expect(text).toContain("pinned snapshot");
		expect(text).toContain("without fetching it again");
		expect(text).toContain("Scope: user");
	});
});

/* -------------------------------------------------------------------------- */

describe("installMarketplacePlugin", () => {
	test("blocks installation on a hard blocker without prompting or installing", async () => {
		const { manager, calls } = fakeManager();
		let prompted = false;
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report: emptyReport({ blockers: ["Symlink escapes plugin root: link -> /etc"] }) }),
			confirm: async () => {
				prompted = true;
				return true;
			},
		});
		expect(outcome.status).toBe("blocked");
		expect(prompted).toBe(false);
		expect(calls).toEqual([]);
	});

	test("does not install when the user declines", async () => {
		const { manager, calls } = fakeManager();
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report: emptyReport() }),
			confirm: async () => false,
		});
		expect(outcome.status).toBe("declined");
		expect(calls).toEqual([]);
	});

	test("installs through the native manager and verifies the installed payload", async () => {
		const tree = makeTree({ "skills/review/SKILL.md": "# Review\n" });
		const report = await inspectPluginDirectory(tree);
		const { manager, calls } = fakeManager({ installPath: tree });
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			force: true,
			scope: "project",
			inspect: async () => ({ report, origin: "local" }),
			confirm: async () => true,
		});
		expect(outcome.status).toBe("installed");
		expect(outcome.entry?.version).toBe("1.2.3");
		expect(calls).toEqual([{ name: "demo", marketplace: "market", options: { force: true, scope: "project" } }]);
	});

	test("reports unverified when the installed copy drifts from the audited source", async () => {
		const audited = makeTree({ "skills/a/SKILL.md": "one" });
		const installed = makeTree({ "skills/a/SKILL.md": "two" });
		const report = await inspectPluginDirectory(audited);
		const { manager } = fakeManager({ installPath: installed });
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report, origin: "remote" }),
			confirm: async () => true,
		});
		expect(outcome.status).toBe("unverified");
		expect(outcome.problems?.some(problem => problem.includes("differs"))).toBe(true);
	});

	test("reports unsafe when the installed payload has a symlink escape", async () => {
		const audited = makeTree({ "skills/a/SKILL.md": "x" });
		const installed = makeTree({ "skills/a/SKILL.md": "x" });
		const outside = makeTree({});
		symlinkSync(outside, join(installed, "linked-outside"));
		const report = await inspectPluginDirectory(audited);
		const { manager } = fakeManager({ installPath: installed });
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report }),
			confirm: async () => true,
		});
		expect(outcome.status).toBe("unsafe");
		expect(outcome.message).toContain("omp plugin uninstall demo@market");
	});

	test("rolls back a plugin whose installed payload fails the audit", async () => {
		const audited = makeTree({ "skills/a/SKILL.md": "x" });
		const installed = makeTree({ "skills/a/SKILL.md": "x" });
		symlinkSync(makeTree({}), join(installed, "linked-outside"));
		const report = await inspectPluginDirectory(audited);
		const { manager } = fakeManager({ installPath: installed });
		const rolledBack: string[] = [];
		manager.uninstallPlugin = async pluginId => {
			rolledBack.push(pluginId);
		};
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report }),
			confirm: async () => true,
		});
		expect(outcome.status).toBe("unsafe");
		expect(rolledBack).toEqual(["demo@market"]);
		expect(outcome.message).toContain("rolled back");
	});

	test("reports a manager failure without throwing", async () => {
		const { manager } = fakeManager({ failInstall: true });
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => ({ report: emptyReport() }),
			confirm: async () => true,
		});
		expect(outcome.status).toBe("failed");
		expect(outcome.message).toContain("cache write failed");
	});

	test("reports an inspection failure without touching the manager", async () => {
		const { manager, calls } = fakeManager();
		const outcome = await installMarketplacePlugin({
			manager,
			name: "demo",
			marketplace: "market",
			inspect: async () => {
				throw new Error("marketplace not found");
			},
			confirm: async () => true,
		});
		expect(outcome.status).toBe("failed");
		expect(calls).toEqual([]);
	});
});
