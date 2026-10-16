import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LINK_SCHEME, parseLinkTarget } from "./internal-links";

/**
 * Terminal click → OMP session bridge. Transcript rows carry OSC 8 links of the form
 * `hydemods://open?s=<key>&u=<uri>`; the macOS handler app registered for the `hydemods` scheme
 * reads `s` and writes the whole link, one line, to `<links dir>/<key>.sock`. Each OMP process
 * listens on its own socket and opens the URL in the browser of its active session.
 */

/** Runtime sockets live under the OMP home, never in a temp dir; `homedir()` keeps the unix path short. */
export const LINKS_DIR = join(homedir(), ".omp", "hydemods", "links");
export const HANDLER_APP = join(homedir(), "Applications", "OMP Link Handler.app");

export type LinkServer = { path: string; stop(): void };

/** Listens for forwarded links; `onOpen` gets each decoded internal URL addressed to `key`. */
export function startLinkServer(key: string, onOpen: (uri: string) => void): LinkServer {
	mkdirSync(LINKS_DIR, { recursive: true, mode: 0o700 });
	const path = join(LINKS_DIR, `${key}.sock`);
	rmSync(path, { force: true });
	const server = Bun.listen<{ buffer: string }>({
		unix: path,
		socket: {
			open(socket) { socket.data = { buffer: "" }; },
			data(socket, chunk) {
				socket.data.buffer += chunk.toString();
				// Each forwarded link is one line; keep an unterminated tail for the next chunk.
				const lines = socket.data.buffer.split("\n");
				socket.data.buffer = lines.pop() ?? "";
				for (const line of lines) {
					const parsed = parseLinkTarget(line);
					if (parsed?.key === key) onOpen(parsed.uri);
				}
			},
			close(socket) {
				const parsed = parseLinkTarget(socket.data.buffer);
				if (parsed?.key === key) onOpen(parsed.uri);
			},
			error() { /* a broken forward is the handler's problem, not the session's */ },
		},
	});
	const stop = () => { server.stop(true); rmSync(path, { force: true }); };
	process.once("exit", stop);
	return { path, stop };
}

/** Shell the handler app runs for each click: route by `s`, hand the link to that socket. */
const FORWARD_SH = `#!/bin/sh
# Installed by hydemods (/browse install-handler). Forwards a hydemods:// link to the OMP process that drew it.
u="$1"
k=$(printf '%s' "$u" | sed -n 's/.*[?&]s=\\([A-Za-z0-9._~-]*\\).*/\\1/p')
[ -n "$k" ] || exit 0
s="${LINKS_DIR}/$k.sock"
[ -S "$s" ] || exit 0
printf '%s\\n' "$u" | /usr/bin/nc -U "$s"
`;

const HANDLER_SCPT = `on open location theURL
	do shell script quoted form of POSIX path of (path to resource "forward.sh") & " " & quoted form of theURL
end open location
`;

/**
 * Shared with the rendering side: links are only drawn when a click has somewhere to go.
 * Cached: one stat per process, refreshed by `installLinkHandler`. Called from every row render.
 */
let handlerInstalled: boolean | undefined;

export function linkHandlerInstalled(): boolean {
	handlerInstalled ??= process.platform === "darwin" && existsSync(join(HANDLER_APP, "Contents", "Resources", "forward.sh"));
	return handlerInstalled;
}

/**
 * Builds the `hydemods://` scheme handler as an AppleScript applet (no Xcode, no signing) and
 * registers it with LaunchServices. Idempotent; rerun after moving the OMP home.
 */
export async function installLinkHandler(): Promise<string> {
	if (process.platform !== "darwin") throw new Error("The link handler is macOS only (LaunchServices URL scheme).");
	mkdirSync(join(homedir(), "Applications"), { recursive: true });
	rmSync(HANDLER_APP, { recursive: true, force: true });
	await run(["osacompile", "-o", HANDLER_APP, "-"], HANDLER_SCPT);
	const resources = join(HANDLER_APP, "Contents", "Resources");
	await Bun.write(join(resources, "forward.sh"), FORWARD_SH, { mode: 0o755 });
	await run(["chmod", "755", join(resources, "forward.sh")]);
	const plist = join(HANDLER_APP, "Contents", "Info");
	await run(["defaults", "write", plist, "CFBundleIdentifier", "dev.hydemods.link-handler"]);
	await run(["defaults", "write", plist, "LSUIElement", "-bool", "true"]);
	await run(["defaults", "write", plist, "CFBundleURLTypes", "-array", `{ CFBundleURLName = "${LINK_SCHEME}"; CFBundleURLSchemes = ("${LINK_SCHEME}"); }`]);
	// `defaults` rewrites the plist as binary; LaunchServices reads either, but normalize for readers.
	await run(["plutil", "-convert", "xml1", `${plist}.plist`]);
	await run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", HANDLER_APP]);
	handlerInstalled = true;
	return HANDLER_APP;
}

async function run(cmd: string[], stdin?: string): Promise<void> {
	const proc = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "ignore", stderr: "pipe" });
	const res = new Response(proc.stderr);
	const readStderr = async () => (res && "text" in res && typeof res.text === "function" ? await (res.text as () => Promise<string>)() : "");
	const [code, stderr] = await Promise.all([proc.exited, readStderr()]);
	if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${stderr.trim() || "no output"}`);
}
