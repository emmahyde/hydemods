import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function registerDispatch(pi: ExtensionAPI): void {
	const running = new Map<string, AbortController>();
	let generation = 0;
	const reset = () => {
		generation++;
		for (const controller of running.values()) controller.abort();
		running.clear();
	};
	pi.on("session_switch", reset);
	pi.on("session_branch", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);

	pi.registerCommand("dispatch", {
		description: "Run a subagent directly: /dispatch <assignment>; /dispatch cancel stops your dispatched agents",
		handler: async (args, ctx) => {
			const task = args.trim();
			const post = (content: string) => pi.sendMessage(
				{ customType: "hydemods-dispatch", display: true, content },
				{ triggerTurn: false },
			);
			if (!task) {
				post("Usage: /dispatch <assignment>\n/dispatch cancel stops all agents launched by this command. Agents share the working directory, not the main conversation. Include all needed context in the assignment.");
				return;
			}
			if (task === "cancel") {
				for (const controller of running.values()) controller.abort();
				post(`Cancellation requested for ${running.size} dispatched agent(s).`);
				return;
			}
			const id = `Dispatch-${randomUUID()}`;
			const controller = new AbortController();
			const startedGeneration = generation;
			running.set(id, controller);
			post(`Dispatched ${id}\n\n${task}`);
			// Do not await: the command releases the editor while the child runs.
			void (async () => {
				try {
					const flags = ["--print", "--mode", "text", "--no-session", "--no-title"];
					if (ctx.model) flags.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
					const output = await new Promise<string>((resolve, reject) => {
						const child = execFile("omp", flags, {
							cwd: ctx.cwd,
							signal: controller.signal,
							maxBuffer: 8 * 1024 * 1024,
						}, (error, stdout, stderr) => {
							if (error) reject(new Error([error.message, stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n")));
							else resolve(stdout.trim());
						});
						// stdin keeps assignments literal, including leading flags or @file text.
						child.stdin?.on("error", error => {
							child.kill();
							reject(error);
						});
						child.stdin?.end(task);
					});
					if (generation !== startedGeneration) return;
					post(`${id} ${controller.signal.aborted ? "cancelled" : "completed"}\n\n${output || "No result text returned."}`);
				} catch (error) {
					if (generation === startedGeneration) post(`${id} ${controller.signal.aborted ? "cancelled" : "failed"}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					running.delete(id);
				}
			})();
		},
	});
}
