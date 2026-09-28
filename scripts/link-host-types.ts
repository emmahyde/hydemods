import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * tsc cannot use Bun's runtime resolution, which finds packages in the install cache without a
 * local node_modules. Link what the extension imports into node_modules so `bun run typecheck`
 * works before (or without) `bun install`:
 *   - the running host that provides `omp` on PATH (the install tests/host.ts also uses),
 *   - this package's own dependencies,
 *   - Bun's types, which `tsconfig.json` names as `bun`.
 */

const root = resolve(import.meta.dir, "..");
const nodeModules = join(root, "node_modules");

/** Directory holding the package a bare specifier resolves to, in the way the runtime loads it. */
function packageRoot(specifier: string, from: string): string {
	let dir = dirname(Bun.resolveSync(specifier, from));
	while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
	return dir;
}

/** Bun's own typings live in the install cache rather than in any installed package. */
function bunTypesRoot(): string {
	const scope = join(process.env.BUN_INSTALL || join(process.env.HOME || "", ".bun"), "install", "cache");
	const match = existsSync(scope) && readdirSync(scope).find(entry => /^bun-types@/.test(entry));
	if (!match) throw new Error(`Bun types not found in ${scope}; run \`bun install\` or install @types/bun.`);
	return join(scope, match);
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

link("@oh-my-pi", dirname(packageRoot("@oh-my-pi/pi-coding-agent", hostDirectory)));
link("@toon-format/toon", packageRoot("@toon-format/toon", root));
link("yaml", packageRoot("yaml", root));
link("@types/bun", bunTypesRoot());
