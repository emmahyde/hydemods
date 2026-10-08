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

- **Integrated tool cards** — draws tool results inside OMP's own tool card. Read prose, Bash output (including errors), and Python evaluator output collapse to a preview with the full content on Ctrl+O. Reads and whole-file writes show the file's declaration outline (writes add any LSP diagnostics); edits show the declarations they touched, with changed lines and diagnostics on Ctrl+O. Backgrounded shell commands collapse to one line.
- **TOON for the model** — hands JSON tool results (including MCP server JSON responses and fenced ```` ```json ```` blocks) to the model as TOON (Token-Oriented Object Notation), a compact table-like form that costs far fewer tokens than JSON; you still see OMP's JSON tree.
- **Session title** — names the session once from the first prompt and locks it; `/rename` still overrides.
- **Last prompt drawer** — shows a preview of your latest prompt above the editor.
- **vault:// completion drawer** — typing `vault://` opens a drawer of your Obsidian vaults (read from Obsidian's own registry), then their folders and notes, the way `agent://` does. Picking a folder reopens the drawer one level down.
- **pr:// completion drawer** — typing `pr://` opens a drawer of your own open pull requests, filterable by number, `owner/repo/`, or title text. Each entry shows CI state, unresolved review threads, and merge conflicts. It needs an authenticated [`gh`](https://cli.github.com); the list is fetched in the background and refreshed after a minute. Optional environment variables:
  - `HYDEMODS_PR_OWNERS=org1,org2` limits the list to those repo owners.
  - `HYDEMODS_PR_APPROVER=<regex>` adds an `approved` column that lights up when a reviewer whose login matches (case-insensitive, bots without the `[bot]` suffix) has approved.
- **Stalled agent alerts** — checks the current session and its subagents every 30 seconds and sends an OMP warning plus a macOS notification. Subagent stalls are also posted into the main agent's conversation (steering a running turn, or starting one when idle) so it can kill, respawn, or nudge the agent itself. Subagents that finished with `yield` are not treated as stalled. Model waits alert once after five minutes without persisted progress. Tool calls escalate: at 6 minutes the stuck subagent is asked to check in, at 12 minutes you get another alert, and at 20 minutes the subagent's turn is aborted and it is told to narrow the call and continue. The main session is only ever alerted, never steered or aborted. Override with `HYDEMODS_STALL_MODEL_MIN` and `HYDEMODS_STALL_TOOL_STAGES` (comma-separated minutes, e.g. `6,12,20`; the first stage checks in, the last aborts).
  Subagent transcripts not written since OMP started are ignored, since subagents never survive a restart. Stall messages render as a one-line card.
- **Runaway edit guard** — aborts an `edit` call while it streams once its input repeats `*** End Patch` three times or passes 96 KB (a model stuck in apply_patch style otherwise streams to the output cap), then tells the agent to retry with small hashline ops.

The extension also registers a **`monitor` tool** for agents: `start` a named shell command (run with `zsh -lc` in its own process group), then end the turn. The default `mode: "stream"` runs it once as a long-lived watcher, and every stdout line it prints becomes a **Monitor event** in the session (`Monitor event: <line> · <name>`; lines within ~300ms share one event) that starts a turn, so the agent can comment on progress as it happens. Watchers should print only state changes (e.g. a `while` loop that echoes `gh pr checks` when it differs from last time). When the command exits or times out (`timeoutMin`, default 60; the process group is killed), a final Monitor card reports the exit code and last 8 output lines (Ctrl+O for all). `mode: "poll"` re-runs the command every `intervalSec` and reports once when it exits 0 or matches `until`; `mode: "exit"` runs it once (e.g. `gh pr checks 123 --watch`) and reports only on exit. `list` and `cancel` manage running monitors; they stop when the session changes or the extension reloads.

It also registers two model tools. **`call_model`** sends a one-shot prompt straight to a configured model (`provider/id`, bare id, or `@role`, with an optional `:effort` suffix or a `thinking` argument) and returns its text, with no tools and no session history. **`agent_model`** overrides which model a task subagent type (`reviewer`, `task`, `scout`, …) runs on via `task.agentModelOverrides`, for this session only: `list`, `set`, and `clear`. Nothing is persisted; use `/agents` for that. Because the override layer is deep-merged over persisted settings, `clear` can only remove the session override; a persisted entry for the same agent keeps applying and is reported.

It also registers a **`ror`** (ready for review) tool. It fetches your open PRs with the same GraphQL search as the `pr://` drawer, keeps the ones that are ready (not a draft, one of the configured approvers' latest review approves the head commit, no reviewer's latest review requests changes, CI passing, no unresolved review threads, no merge conflicts), groups them by your stored review tiers, and DMs the list to you on Slack. `op: "send"` (default) sends, `"preview"` returns the message, and `"label"` with `tier` and `prs` (`owner/repo#N`, `#N`, or `N` when unambiguous) moves PRs to the end of a tier. Ready PRs in no tier are classified by a model (`classify: false` skips this): it reads each PR's description, file list and diff, judges **risk** (how many pre-existing behaviors, callers and flows the change touches, and how wide and silent a failure would be; size, file type, migrations and commit type are explicitly not risk signals), and the PR is stored at the end of the tier it picks. The tool result lists each choice with the model's one-sentence reason (the Slack message carries no reasons); PRs the model fails on stay under "Not tiered yet". Choices the model made are recorded in `autoTiered`. Correct one with `label`, which moves the PR and removes it from `autoTiered`, making it your ground truth: your own tiered open PRs are shown to the classifier as examples, model-chosen ones are not. Slack goes through `mcx forward` (it must be on `PATH`), so the Slack MCP's own sign-in is reused and the DM goes to whoever it is signed in as. Long lists are split into several messages at section breaks. Config lives in `~/.config/hydemods/ror.json` (override with `HYDEMODS_ROR_CONFIG`):

```json
{
 "approvers": ["review-bot", "other-review-bot"],
 "owners": ["your-org"],
 "heading": "Ready for review",
 "slackServer": "slack",
 "tiers": [
  { "key": "small", "label": "Small, low risk", "description": "Adds code beside existing behavior, or changes something few callers reach.", "prs": ["your-org/app#12"] },
  { "key": "medium", "label": "Medium risk", "description": "Modifies shared behavior that several flows pass through.", "prs": ["your-org/app#13"] }
 ],
 "classifierModel": "@default:medium",
 "autoTiered": { "your-org/app#13": "Edits the shared date formatter used by every report." }
}
```

The same thing runs as the **`/ror`** command: `/ror` sends, `/ror preview` shows the message in the session, `raw` (either form) skips the model, `/ror label <tier> <#N...>` corrects tiers, and `/ror watch <#N...>` or `/ror watch --full` starts a watch.

`op: "watch"` starts a background monitor named `ror-watch` that runs `scripts/ror-watch.ts`. Every `intervalSec` (default 300, minimum 30) it re-fetches your PRs. If GitHub still reports a watched PR's mergeability as unknown, it fetches once more 15 seconds later. It wakes the session only with changes. Each changed PR gets a status line with its link: `ROR`, `closed or merged`, or `not ROR:` followed by every blocker. A PR that is not ROR also gets one indented line per specific blocker, fetched in batched GraphQL:

- each failing check, with its link, and the names of pending checks
- each unresolved review thread: `path:line`, author, a one-line snippet of the first comment, and links to the first and latest comments
- each change request: reviewer, snippet and link
- approver state: no review yet, an approval on an older commit (with both SHAs), or a dismissed or comment-only review
- conflicts with the base branch

A pending check finishing doesn't count as a change. A new failing check, a new thread, a new change request or a new approver review does. Each report starts with a count line: PRs watched, how many are ROR, how many aren't. The first poll reports every PR.

With `prs`, the monitor watches those and exits once all of them are ROR or closed. With `full: true` instead, it watches every open PR in `owners` from `ror.json`. New PRs join as they open, and a closed PR is reported once and then dropped. That watch runs until `timeoutMin` (default 1440). Events can run up to 500 lines, so the first full report isn't cut off. Starting a new watch replaces the running one. To stop it, call `monitor` with `op: "cancel"` and `name: "ror-watch"`. Running `bun scripts/ror-watch.ts --full --once` prints a single report and exits.

`approvers` are reviewer logins (bots without `[bot]`); an approval from any one of them counts. `slackServer` is the `mcx forward --list` name of your Slack MCP, and `owners` and `heading` are optional. A tier's optional `description` says what belongs in it and is passed to the classifier along with `key` and `label`. `classifierModel` is a model selector as for `call_model` (`provider/id`, bare id, or `@role`, optional `:effort`) and defaults to `@default:medium`. `autoTiered` (PR key to the model's reason) is maintained by the tool.

Your own calibration for the classifier goes in `ror-guidance.md` next to `ror.json` (override with `HYDEMODS_ROR_GUIDANCE`). It is plain text, such as examples of the kinds of change you put in each tier and why; the classifier treats it as overriding its defaults. A missing file is fine.

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
