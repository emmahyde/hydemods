import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * tsc cannot use Bun's runtime resolution, which finds packages in the install cache without a
 * local node_modules. Link what the extension imports into node_modules so `bun run typecheck`
 * works before (or without) `bun install`:
 *   - the running host that provides `omp` on PATH (the install tests/host.ts also uses),
 *   - this package's own dependencies,
 *   - Bun's types (`bun`) and the packages they import (`@types/node`, `undici-types`).
 */

const root = resolve(import.meta.dir, "..");
const nodeModules = join(root, "node_modules");

/** Directory holding the package a bare specifier resolves to, in the way the runtime loads it. */
function packageRoot(specifier: string, from: string): string {
	let dir = dirname(Bun.resolveSync(specifier, from));
	while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
	return dir;
}

const bunCache = join(process.env.BUN_INSTALL || join(process.env.HOME || "", ".bun"), "install", "cache");

/**
 * Install-cache entry for `name` (flat `name@x.y.z@@@n` entries) at the highest version satisfying
 * `range`, so the choice does not depend on directory listing order.
 */
function cachePackage(name: string, range = "*"): string {
	const base = name.includes("/") ? join(bunCache, dirname(name)) : bunCache;
	const prefix = `${name.split("/").pop()}@`;
	const found = (existsSync(base) ? readdirSync(base) : [])
		.filter(entry => entry.startsWith(prefix))
		.map(entry => ({ dir: join(base, entry), version: entry.slice(prefix.length).split("@")[0] }))
		.filter(entry => Bun.semver.satisfies(entry.version, range))
		.sort((a, b) => Bun.semver.order(b.version, a.version));
	if (!found.length) throw new Error(`${name}@${range} not found in ${base}; run \`bun install\` or install @types/bun.`);
	return found[0].dir;
}

/**
 * Copy a cached declaration package into node_modules as a real directory. tsc resolves symlinks to
 * their real path, so a symlink into the cache would look up `undici-types` and `@types/node`
 * beside the cache entry, where they do not exist, and leave `Response`, `Request` and `Headers`
 * unresolved. Only declarations are copied.
 */
function copyTypes(name: string, source: string): void {
	const path = join(nodeModules, name);
	rmSync(path, { recursive: true, force: true });
	mkdirSync(dirname(path), { recursive: true });
	cpSync(source, path, {
		recursive: true,
		dereference: true,
		filter: file => (statSync(file).isDirectory() ? file.split(sep).pop() !== "docs" : /\.d\.[cm]?ts$|(^|\/)package\.json$/.test(file)),
	});
}

/** Bun's types plus what they import; without a DOM lib, `Response` etc. come from `undici-types`. */
function installTypes(): void {
	const nodeTypes = cachePackage("@types/node");
	const undiciRange = JSON.parse(readFileSync(join(nodeTypes, "package.json"), "utf8")).dependencies?.["undici-types"] ?? "*";
	copyTypes("@types/bun", cachePackage("bun-types"));
	copyTypes("@types/node", nodeTypes);
	copyTypes("undici-types", cachePackage("undici-types", undiciRange));
}

function link(name: string, target: string): void {
	if (resolve(target).startsWith(nodeModules + sep)) return; // the local copy is already resolvable
	const path = join(nodeModules, name);
	rmSync(path, { recursive: true, force: true });
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, "dir");
}

const executable = Bun.which("omp");
if (!executable) throw new Error("Typecheck needs `omp` on PATH; it supplies the @oh-my-pi/* types.");
const hostDirectory = dirname(realpathSync(executable));

const home = process.env.HOME || "";
const localMonorepo = [join(home, "src", "oh-my-pi"), join(home, "projects", "oh-my-pi")].find(dir => existsSync(dir)) ?? join(home, "src", "oh-my-pi");
const hostOhMyPi = dirname(packageRoot("@oh-my-pi/pi-coding-agent", hostDirectory));
link("@oh-my-pi", hostOhMyPi);
link("@toon-format/toon", packageRoot("@toon-format/toon", root));
link("yaml", packageRoot("yaml", root));
installTypes();
const localAssetsTypes = join(localMonorepo, "types", "assets");
if (existsSync(localAssetsTypes)) {
	link("@types/assets", localAssetsTypes);
} else {
	// Published @oh-my-pi/* packages do not ship monorepo types/assets; synthesize the full stub
	// so `tsconfig.json`'s `"types": ["bun", "assets"]` and any host `.ts` imports resolve cleanly.
	const stubDir = join(nodeModules, "@types", "assets");
	rmSync(stubDir, { recursive: true, force: true });
	mkdirSync(stubDir, { recursive: true });
	const declarations = [
		'declare module "*.md" { const content: string; export default content; }',
		'declare module "*.txt" { const content: string; export default content; }',
		'declare module "*.py" { const content: string; export default content; }',
		'declare module "*.rb" { const content: string; export default content; }',
		'declare module "*.jl" { const content: string; export default content; }',
		'declare module "*.lark" { const content: string; export default content; }',
		'declare module "*.sh" { const content: string; export default content; }',
		'declare module "*.applescript" { const content: string; export default content; }',
		'declare module "*.bdf" { const content: string; export default content; }',
		'declare module "*.css" { const content: string; export default content; }',
		'declare module "*/template.js" { const content: string; export default content; }',
		'declare module "*.generated.js" { const content: string; export default content; }',
		'declare module "axe-core/axe.min.js" { const content: string; export default content; }',
	].join("\n") + "\n";
	writeFileSync(join(stubDir, "index.d.ts"), declarations);
}
