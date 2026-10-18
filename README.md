# Hydemods

Tweaks for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). The `/hydemods` panel shows each tweak and turns it on or off. All tweaks start on.

## Install

You need [Bun](https://bun.sh) and git on your PATH.

```sh
curl -fsSL https://raw.githubusercontent.com/emmahyde/hydemods/main/install.sh | sh
```

Restart OMP or run `/reload-plugins`. Then open `/hydemods`.

## Tweaks

- **Integrated tool cards.** Results show inside the tool card of OMP. The tool name is green on success and red on error, with no prefix symbol.
  - Prose reads, Bash output, and Python output collapse to a preview. Ctrl+O shows all.
  - Collapsed previews keep their row budget for content. Sequential lines show from the top, and an inline `[...]` at the end of the last line marks truncation; it never takes a separate row.
  - Reads and writes show the declaration outline. Writes add LSP diagnostics. Modules or namespaces that only wrap one class fold into its row (`class Shop::Billing::Invoice < Base`), so the class's methods show.
  - File excerpts hide snapshot hashes, numbered gutters and comments; their bracketed path/range label appears only once.
  - Shell `grep -rn` / `rg -n` rows drop the repeated `path:line:` prefix; matches group under one filename header per file.
  - Edits show the declarations they touched. Ctrl+O shows the changed lines.
  - Background shell commands collapse to one line.
  - `wait` collapses to one status line with job counts and names (for example `✓ Wait · 1 completed GatePoll`). Failures lead and turn red. Ctrl+O shows the full snapshot; the model always gets the full result.
- **Tool rows.** `hydemods.toolRows` in `/settings` (Tools) picks how tool calls draw; Opt+O cycles it (cards → lines → group) and flashes which one is on. Ctrl+O shows the full cards in any mode.
  - `lines` (default): one row per call, `• Bash · Show recent commits touching db/migrate`, on adjacent rows with no gap. A local model writes each line from the call's arguments; until it lands, the row shows the agent's intent.
  - `group`: one row per burst of calls. While the agent works it names the latest call; when the agent replies, or you send a message, a local model titles the burst (`• Trace how sessions authenticate users · 7 calls`).
  - `cards`: OMP's tool cards, unchanged.
  - A run spans the thinking and harness notices (status lines, reminders, extension messages) between its calls; they hide inside the run. A reply or a prompt ends it.
  - A run's rows reach scrollback only once the run ends and its lines land (at most 4 seconds after), so scrollback keeps the finished text.
  - `hydemods.toolRowsModel` names the local model (`omp tiny-models` lists them; default `llama3.2:3b`). Set `providers.tinyModelDevice` to `mlx` to run it on the Apple GPU; otherwise OMP runs it on the CPU. The first line waits for the model to download and load. Call arguments never leave the machine.
- **TOON for the model.** The model gets JSON tool results as TOON, a compact table form that uses far fewer tokens. You still see the JSON tree.
- **Session title.** The first prompt names the session once. `/rename` still works.
- **Last prompt drawer.** A preview of your latest prompt shows above the editor.
- **Runaway edit guard.** An `edit` call stops when its input repeats `*** End Patch` three times or passes 96 KB. The agent then retries with small hashline ops.
- **Tool toggles.** `/hydemods` also switches the `monitor`, `call_model`, `agent_model`, `recommend_tools`, and `ror` tools. Off removes the tool from the active set. Off for `ror` also turns `/ror` into a no-op. The runaway edit guard has its own toggle too. All default to on.
- **Message backgrounds.** `/hydemods` has a Colors section with a preset row each for prompts, responses, and tool calls (`off`, `slate`, `blue`, `green`, `amber`, `purple`, `rose`). `off` keeps your theme color, and it is the default.
  - Presets pick a dark or light tint to match your theme. To use any color, set `hydemods.userBgHex`, `hydemods.assistantBgHex`, or `hydemods.toolBgHex` to `#rrggbb` in `settings.yaml`. A hex wins over the preset.
  - The tool color covers pending and successful calls. Failed calls stay red.
  - Lines already in your terminal scrollback keep their old color.
- **`vault://` drawer.** Lists your Obsidian vaults, then their folders and notes.
- **`xd://` drawer.** Lists the session's mounted tools with their descriptions. Type part of a name to filter. Tab expands tools that have documentation topics.
- **`proc://` drawer.** Lists session jobs, running agents, and project services with their status. Select one, then Tab to see its URL actions. Completion only inserts a URL. It never stops or changes a process.
- **`pr://` drawer.** Lists your open PRs with CI state, unresolved threads, and conflicts. It needs an authenticated [`gh`](https://cli.github.com).
  - `HYDEMODS_PR_OWNERS=org1,org2` limits the list to those owners.
  - `HYDEMODS_PR_APPROVER=<regex>` adds an `approved` column for matching reviewers.
- **Stalled agent alerts.** Every 30 seconds, it checks the session and its subagents. An alert is an OMP warning and a macOS notification.
  - Subagent stalls also go to the main agent, which can kill, respawn, or nudge the subagent.
  - A model wait alerts after 5 minutes without progress.
  - A stuck tool call escalates: check-in at 6 minutes, second alert at 12, abort at 20.
  - The main session gets alerts only.
  - `HYDEMODS_STALL_MODEL_MIN` and `HYDEMODS_STALL_TOOL_STAGES` (for example `6,12,20`) change the timing.
- **Internal URL browser.** `/browse [url]` or Ctrl+Shift+U opens a fullscreen browser over every internal scheme (`vault://`, `xd://`, `proc://`, `omp://`, `pr://`, ...): a scheme rail, a searchable list, and an inspector for the selected entry. Up/Down select, Right/Enter open, Left back, Tab inserts the URL into the editor, Esc closes. In the inline completion for an internal URL, the first item (`Browse ...`) opens the same browser at that URL.
  - Ctrl+Shift+U opens at the internal URL nearest the end of the editor text when there is one.
  - **Clickable links (macOS).** Run `/browse install-handler` once. It builds `~/Applications/OMP Link Handler.app`, an AppleScript applet registered for the `hydemods://` URL scheme. From then on, internal URLs in responses and tool cards are OSC 8 hyperlinks; Cmd+click one in iTerm2, Ghostty, Kitty, or WezTerm, and the browser opens on it in the OMP session that drew it (an open browser navigates instead). Links follow `tui.hyperlinks`; each OMP process listens on `~/.omp/hydemods/links/<key>.sock`. Without the handler, rows stay plain.

<img width="1000" alt="AST-structured read output" src="https://github.com/user-attachments/assets/d8dde60d-e63c-40d0-9257-5d26e3c6a982" />
<img width="1000" alt="AST-structured edit output" src="https://github.com/user-attachments/assets/ce8a4924-5510-431c-a90a-12d123dc60e4" />
<img width="1000" alt="Grep TOON output" src="https://github.com/user-attachments/assets/337cf682-8902-4580-a5c2-98b911fa42ae" />
<img width="1000" alt="Eval TOON output" src="https://github.com/user-attachments/assets/56e8e941-a37b-4fb1-bab3-37bfb4e7272a" />
<img width="1000" alt="Bash pretty printing" src="https://github.com/user-attachments/assets/17110cea-b94e-4957-b9c5-c31d37fbbf33" />

Eval cells that print `archive` listings or a session detail (sessions, projects, prompts/search, recaps, one session) render them as TOON cards in both the ANSI and native paths; surrounding prose, status and artifact notices are kept, and the model-visible result is unchanged.

## Agent tools

- **`monitor`.** Runs a named shell command (`zsh -lc`) in the background. Operations: `start`, `list`, `cancel`.
  - `stream` (default): each stdout line is a Monitor event that starts a turn. Print state changes only.
  - `poll`: runs every `intervalSec`. It reports when the command exits 0 or the output matches `until`.
  - `exit`: runs once. It reports on exit.
  - `timeoutMin` defaults to 60. A final card shows the exit code and the last 8 lines.
  - When the session exposes its job manager, each monitor is also one native job. `proc://` lists it for its whole life, `proc://<id>/kill` cancels it, and `list` shows its `proc://` id. Without a job manager the monitor runs the same way, without a `proc://` entry.
- **`call_model`.** Sends a one-shot prompt to a model (`provider/id`, bare id, or `@role`, with an optional `:effort`). No tools, no history.
- **`agent_model`.** Sets the model for a subagent type (`reviewer`, `task`, `scout`) for this session only. Operations: `list`, `set`, `clear`. `clear` cannot remove a saved setting. Use `/agents` for that.
- **`recommend_tools`.** Asks the `judge` role which tools and skills fit a task. Each candidate becomes one yes/no question, sent in batches of 40. Returns up to `limit` matches (default 5) scoring at least 50%, best first. Judge cost is billed to the session.
- **`ror` (ready for review).** Finds your ready PRs, groups them in tiers, and sends them in a Slack DM.

## ROR

A PR is ready when it is not a draft, an approver approved the head commit, no review requests changes, CI passes, no thread is unresolved, and no conflict exists.

- **Operations.** `send` (default), `preview`, `label`, and `watch`. The `/ror` command does the same: `/ror`, `/ror preview`, `/ror label <tier> <#N...>`, `/ror watch <#N...|--full>`. Add `raw` to skip the model.
- **Slack.** The DM goes through `mcx forward` (on `PATH`) to the account of the Slack MCP. Long lists split into several messages.
- **Tiering.** A model tiers the ready PRs that are in no tier. `classify: false` skips it.
  - It reads the description, files, and diff, and judges risk. Risk is how many behaviors, callers, and flows the change touches, and how wide and silent a failure is. Size, file type, and migrations are not signals.
  - The tool result lists each choice with a reason. Model choices are saved in `autoTiered`.
  - `label` moves a PR and makes it your ground truth. The model sees your tiered PRs as examples.
  - Put extra guidance in `ror-guidance.md` next to `ror.json` (`HYDEMODS_ROR_GUIDANCE` overrides the path).
- **Watch.** `op: "watch"` starts a monitor named `ror-watch` that runs `scripts/ror-watch.ts`.
  - It polls every `intervalSec` (default 300, minimum 30) and wakes the session only on changes.
  - `prs` watches those PRs and exits when all are ROR or closed. `full: true` watches every open PR in `owners` until `timeoutMin` (default 1440).
  - A report has a count line and one status line for each changed PR: `ROR`, `closed or merged`, or `not ROR:` with the blockers. Each blocker gets its own line with a link: failing checks, unresolved threads, change requests, approver state, conflicts.
  - A new watch replaces the running one. Stop it with `monitor` `op: "cancel"`, `name: "ror-watch"`.
  - `bun scripts/ror-watch.ts --full --once` prints one report.

Config is `~/.config/hydemods/ror.json` (`HYDEMODS_ROR_CONFIG` overrides the path):

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

- `approvers`: reviewer logins (no `[bot]`). One approval is enough.
- `slackServer`: the name of your Slack MCP in `mcx forward --list`.
- `owners`, `heading`: optional.
- `tiers[].description`: optional. The classifier reads it.
- `classifierModel`: model selector. Default `@default:medium`.
- `autoTiered`: the tool maintains it.

### Claude marketplace browser

Inspired by [pi-claude-marketplace](https://pi.dev/packages/pi-claude-marketplace), Hydemods adds `/claude` to browse Claude plugin marketplaces and install compatible plugins through OMP's native plugin infrastructure. It uses OMP's existing marketplace registry, not a separate Pi installation.

Run `/claude` to open the browser. If no marketplace is configured, it offers to add `anthropics/claude-plugins-official`. Choose a plugin to review its components and confirm installation.

```text
/claude add anthropics/claude-plugins-official
/claude available
/claude inspect plugin-name@marketplace-name
/claude install plugin-name@marketplace-name
/claude installed
/claude update
```

The compatibility report distinguishes supported components from unsupported Claude-specific features. Installing a plugin grants trust to its content: supported extensions and server integrations can execute code when loaded. Review the source and the report before confirming.

After installation, run `/reload-plugins` to load the new resources. The browser does not install the upstream Pi extension or its adapter dependencies.

## Development

Bun, no build step. From the repository root:

```sh
bun install
bun run test
bun run typecheck
```

- `typecheck` links the `@oh-my-pi/*` types of the running OMP (found through `omp` on `PATH`), then runs `tsc --noEmit`.
- `test` skips itself if `omp` is not on `PATH`.
- To test end to end, load the extension from an OMP installation. Edit `index.ts`, then reload OMP.
