# Hydemods

Hydemods is a small visual registry of composable tweaks for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It adds a `/hydemods` panel where you can inspect and toggle the bundled session improvements.

One line, with [Bun](https://bun.sh) and git on your PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/emmahyde/hydemods/main/install.sh | sh
```

Restart OMP or run `/reload-plugins`, and open `/hydemods` to view and toggle the tweaks.

## Included tweaks

### AST-Structured Read & Edit Output
<img width="1000" alt="Screenshot 2026-09-28 at 8 22 48 AM" src="https://github.com/user-attachments/assets/d8dde60d-e63c-40d0-9257-5d26e3c6a982" />
<img width="1000" alt="Screenshot 2026-09-28 at 6 55 21 AM" src="https://github.com/user-attachments/assets/ce8a4924-5510-431c-a90a-12d123dc60e4" />

### Grep TOONification & Pretty Printing
<img width="1000" alt="Screenshot 2026-09-28 at 7 22 53 AM" src="https://github.com/user-attachments/assets/337cf682-8902-4580-a5c2-98b911fa42ae" />

### Eval TOONification & Pretty Printing
<img width="1000" alt="Screenshot 2026-09-28 at 8 27 29 AM" src="https://github.com/user-attachments/assets/56e8e941-a37b-4fb1-bab3-37bfb4e7272a" />

### Bash Pretty Printing
<img width="1000" alt="Screenshot 2026-09-28 at 8 23 55 AM" src="https://github.com/user-attachments/assets/17110cea-b94e-4957-b9c5-c31d37fbbf33" />

All of these tweaks start enabled and can be toggled from the panel:

- **Integrated tool cards** — draws structured tool results inside OMP's own tool card. Reads and whole-file writes show the file's declaration outline (writes add any LSP diagnostics); edits show the declarations they touched, with the changed lines and any LSP diagnostics on Ctrl+O.
- **TOON for the model** — hands JSON tool results (including MCP server JSON responses and fenced ```` ```json ```` blocks) to the model as TOON (Token-Oriented Object Notation), a compact table-like form that costs far fewer tokens than JSON; you still see OMP's JSON tree.
- **Session title** — names the session once from the first prompt and locks it; `/rename` still overrides.
- **Last prompt drawer** — shows a preview of your latest prompt above the editor.
- **vault:// completion drawer** — typing `vault://` opens a drawer of your Obsidian vaults (read from Obsidian's own registry), then their folders and notes, the way `agent://` does. Picking a folder reopens the drawer one level down.
- **pr:// completion drawer** — typing `pr://` opens a drawer of your own open pull requests, filterable by number, `owner/repo/`, or title text. Each entry shows CI state, unresolved review threads, and merge conflicts. It needs an authenticated [`gh`](https://cli.github.com); the list is fetched in the background and refreshed after a minute. Optional environment variables:
  - `HYDEMODS_PR_OWNERS=org1,org2` limits the list to those repo owners.
  - `HYDEMODS_PR_APPROVER=<regex>` adds an `approved` column that lights up when a reviewer whose login matches (case-insensitive, bots without the `[bot]` suffix) has approved.
- **Stalled agent alerts** — checks the current session and its subagents every 30 seconds and sends an OMP warning plus a macOS notification. Subagent stalls are also posted into the main agent's conversation (steering a running turn, or starting one when idle) so it can kill, respawn, or nudge the agent itself. Subagents that finished with `yield` are not treated as stalled. Model waits alert once after five minutes without persisted progress. Tool calls escalate: at 6 minutes the stuck subagent is asked to check in, at 12 minutes you get another alert, and at 20 minutes the subagent's turn is aborted and it is told to narrow the call and continue. The main session is only ever alerted, never steered or aborted. Override with `HYDEMODS_STALL_MODEL_MIN` and `HYDEMODS_STALL_TOOL_STAGES` (comma-separated minutes, e.g. `6,12,20`; the first stage checks in, the last aborts).

The extension also registers a **`monitor` tool** for agents: `start` a named shell check (run with `zsh -lc`; `mode: "poll"` re-runs it every `intervalSec` until it exits 0 or matches `until`; `mode: "exit"` runs it once, e.g. `gh pr checks 123 --watch`), then end the turn. When the check is met, exits, times out (`timeoutMin`, default 60) or fails to run, the result is posted into the session as a compact Monitor card (last 8 output lines; Ctrl+O for all) and starts a turn, so the agent goes idle instead of sleeping in a poll loop. `list` and `cancel` manage running monitors; they stop when the session changes or the extension reloads.
## Install and use in OMP

## Development

This package uses Bun and has no build step. From the repository root:

```sh
bun install
bun run test
bun run typecheck
```

`bun run typecheck` links the running OMP's `@oh-my-pi/*` types (found via `omp` on `PATH`, as the
tests do) into `node_modules` and runs `tsc --noEmit`; `bun run test` skips itself with a clear
message when `omp` is not on `PATH`.

The extension imports OMP runtime modules, so load it from an OMP installation to exercise it end to end. Edit `index.ts` directly, then restart OMP (or reload the extension as you work) to try changes.
