import { execFile } from "node:child_process";

export type RunCommand = (file: string, args: string[]) => void;

const runQuietly: RunCommand = (file, args) => {
 // A missing CLI or a stopped Orca runtime only costs the title, never the session.
 execFile(file, args, { timeout: 5000 }, () => {});
};

/**
 * Orca gives each pane a runtime terminal handle (`ORCA_TERMINAL_HANDLE`); `orca terminal rename`
 * sets the title of that pane's tab. The returned function shows a session name there: a name it
 * already shows is skipped, and no name resets the tab to Orca's own title. Outside Orca it does nothing.
 */
export function orcaPaneTitle(env: Record<string, string | undefined> = Bun.env, run: RunCommand = runQuietly): (name: string | undefined) => void {
 const handle = env.ORCA_TERMINAL_HANDLE;
 const orca = env.ORCA_CLI_BIN_DIR ? `${env.ORCA_CLI_BIN_DIR}/orca` : "orca";
 let shown: string | undefined;
 return name => {
  if (!handle) return;
  const title = name?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() || undefined;
  if (title === shown) return;
  shown = title;
  run(orca, ["terminal", "rename", "--terminal", handle, "--title", title ?? ""]);
 };
}
