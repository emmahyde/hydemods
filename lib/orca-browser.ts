import { execFile } from "node:child_process";

type Tab = { browserPageId: string; url: string };

// The Orca CLI can take several seconds per call when the app is busy.
const OrcaTimeoutMs = 20_000;

function orcaJson(orca: string, args: string[]): Promise<any> {
 const { promise, resolve } = Promise.withResolvers<any>();
 execFile(orca, [...args, "--json"], { timeout: OrcaTimeoutMs }, (error, stdout) => {
  if (error) return resolve(undefined);
  try {
   const reply = JSON.parse(stdout);
   resolve(reply?.ok ? reply.result : undefined);
  } catch {
   resolve(undefined);
  }
 });
 return promise;
}

/**
 * Shows `url` in Orca's embedded browser, in this terminal's worktree: a tab already on that origin
 * is brought forward, else a new tab opens. Resolves false outside Orca or when the runtime does not
 * answer, so the caller can fall back to the system browser.
 */
export async function showInOrcaBrowser(url: string, env: Record<string, string | undefined> = Bun.env): Promise<boolean> {
 const worktree = env.ORCA_WORKTREE_ID;
 if (!env.ORCA_TERMINAL_HANDLE || !worktree) return false;
 const orca = env.ORCA_CLI_BIN_DIR ? `${env.ORCA_CLI_BIN_DIR}/orca` : "orca";
 const scope = ["--worktree", `id:${worktree}`];
 const listed = await orcaJson(orca, ["tab", "list", ...scope]);
 if (!listed) return false;
 const origin = new URL(url).origin;
 const open = (listed.tabs as Tab[] | undefined)?.find(tab => URL.canParse(tab.url) && new URL(tab.url).origin === origin);
 if (open) return (await orcaJson(orca, ["tab", "switch", "--page", open.browserPageId, "--focus", ...scope])) !== undefined;
 return (await orcaJson(orca, ["tab", "create", "--url", url, ...scope])) !== undefined;
}
