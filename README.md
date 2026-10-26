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
- **Tool rows.** `hydemods.toolRows` in `/settings` (Tools) picks how tool calls draw; Ctrl+N cycles it (cards → lines → group) and flashes which one is on. Ctrl+O shows the full cards in any mode.
  - `lines`: one row per call, on adjacent rows with no gap, in three aligned columns: the tool, a status line, and the file in the path colour (`• Read  Reading the invoice totals  invoice.rb:40-80`). The file comes last, so a call without one leaves no gap. Each tool has its own label colour from the theme. A bash row shows the program its command runs (`• Git  Checking recent commits`), past any leading `cd dir &&`. The status line is the agent's intent (`i`) exactly as written. A call without one gets a line from a local model, in the agent's voice and never naming the tool; until it lands, the row shows the call's main argument in dim italics (for a `git commit -m`, only the commit message).
  - Read file labels link to the original local path, not a file with the same name in the working directory. Cmd+click opens the file. Line selectors stay visible; VS Code links also retain the start line. Links follow `tui.hyperlinks`. Missing files stay plain text.
  - `group` (default): while the agent works, a burst lists its calls one per row, as in `lines`. When the agent replies, or you send a message, the calls give way to a status row and one bullet per distinct tool, in the order the tools were first used: the tool, what the agent used it for, and what came of it. A long bullet wraps under its own text. A local model writes the bullets from the steps as they stand when the burst ends, with the most weight on edits, failed steps, and the last steps. Until they land, or if the model is down, each tool's bullet is the line of its last call.
    ```text
    ✓ 26 calls · 4 failed
      • Read Traced how a run commits and found replays dropped cards
      • Bun Ran the replay test, which failed, then passed after the fix
      • Edit Made a frozen head draw every card of its run
    ```
  - Task rows read `Task  <what the subagents were sent to do>  <first agent> +N`, with the subagent footer (state digest and one row per agent) under the row. In `group` mode the footer stays under the Task bullet.
  - Eval rows show the first file the code names (a quoted path with an extension, or a `%load` target) in the file column.
  - The local model gets the agent's intent as a named `intent` field, and the up to three steps before the call as context.
  - `hydemods.wikiBadges` (on by default) puts `◆` before a row's file when the knowledge wiki (`~/.llm-wiki`, or `.llm-wiki` in the working folder) has a page whose title, slug or tags name that file's stem or the skill. Stems shorter than 4 letters never match.
  - `cards`: OMP's tool cards, unchanged.
  - A run spans the thinking and harness notices (status lines, reminders, extension messages) between its calls; they hide inside the run. A reply or a prompt ends it.
  - A run's rows reach scrollback only once the run ends and its lines land (at most 4 seconds after), so scrollback keeps the finished text.
  - `hydemods.toolRowsModel` names the local model (`omp tiny-models` lists them; default `llama3.2:3b`). Set `providers.tinyModelDevice` to `mlx` to run it on the Apple GPU; otherwise OMP runs it on the CPU. The first line waits for the model to download and load. Call arguments never leave the machine.
  - `hydemods.toolPills` (off by default) draws each row's tool label as a pill: upper case, bold, the tool's colour as the fill, and black or white text by the fill's brightness. On a terminal without truecolour, the pill is drawn in reverse video. Each pill is as wide as its label, and the titles after the pills stay aligned. The toggle changes new rows only.
- **@@agent mentions.** Type `@@` in the prompt to list the task agent types that `/agents` shows, each with its description. Keep typing to filter; Tab inserts `@@name`. Your prompt is sent as typed. Before the model turn, a visible note names each mentioned agent and the `task` call that delegates to it. Names match without case. These are skipped: agents in `task.disabledAgents`, names that match no agent, and mentions inside code. Agents from `--extension` roots are not listed. Mentions work in the main session only. Toggle: `@@agent mentions` in `/hydemods`.
- **TOON for the model.** The model gets JSON tool results as TOON, a compact table form that uses far fewer tokens. You still see the JSON tree.
- **Session title.** The first prompt names the session once. `/rename` still works.
- **Last prompt widget.** Under **Widgets** in `/hydemods`, a `❯`-prefixed preview of your latest prompt sits below the editor, before the italic thinking widget. The preview truncates to one terminal row.
- **Thinking widget.** Under **Widgets** in `/hydemods`, italic thinking sits below the last-prompt preview. It shows the original first sentence and last sentence, separated by `...` when middle sentences are omitted. The excerpt keeps three content rows plus a header; overflow ends in `...`. No model call is needed. Ctrl+O shows the full original thought; collapse restores the excerpt. A new turn keeps the last thought until new thinking arrives.
- **Giles widget.** One panel below the editor shows model, retrieval mode, action status, failures and recalled sources. It replaces duplicate status rows and notices when the adapter confirms that the widget can show them.
  Ctrl+O expands original status, notice and recall text. Session replay retains historical Librarian messages; UI-only status does not enter model context.
- **Giles TOON output.** Recall, notices and tool results retain source strings and non-text blocks. Already encoded output is not wrapped again.
- **Text tool labels.** Live and burst rows show names such as `WEB:SEARCH`, `SKILL:SEARCH` and `GILES:RETRO:STATUS`, without icon substitutions. Giles uses `KNWLG` for knowledge and `WK` for work, including `GILES:WK:CHK` and `GILES:WK:FIN`. Skills retain display-only, collision-safe acronyms; no command aliases are added.
  Work references use `WK:REF`, evidence uses `WK:EVID`, and dependency edits use `WK:DEP:ADD` / `WK:DEP:RM`. Feedback uses `FB:SEND`, `FB:STATUS`, `FB:CHK` and `FB:RECON`; remaining actions keep readable words.
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
- **`gallery`.** A shared picture gallery: a live local web page you keep open beside the terminal, so pictures stay out of the scrollback. The agent pushes image files (`paths`) or a `url`, with a `caption`. Each picture appears in the open tab at once, and with **follow** on, the viewer opens it. Other operations: `open`, `list`, `remove`, `clear`. `/gallery` opens the page.
  - One gallery per project, kept across sessions in `~/.omp/gallery/<project>-<hash>/`. Every session of the project shares one stable `127.0.0.1` port, so a tab kept open survives restarts. Pictures are grouped by session.
  - The first push opens the page when no tab shows it. Inside Orca it opens as a tab of Orca's own browser in this workspace, and a later open brings that tab forward instead of adding another. Outside Orca, or when Orca does not answer, it opens in the system browser.
  - Viewer keys: `←`/`→` move, `f` toggles fit and actual size, `c` copies the source path, `d` deletes, `esc` closes. Formats: png, jpg, gif, webp, svg, avif and bmp, up to 50 MB.
- **`call_model`.** Sends a one-shot prompt to a model (`provider/id`, bare id, or `@role`, with an optional `:effort`). No tools, no history.
- **`agent_model`.** Sets the model for a subagent type (`reviewer`, `task`, `scout`) for this session only. Operations: `list`, `set`, `clear`. `clear` cannot remove a saved setting. Use `/agents` for that.
- **`recommend_tools`.** Asks the `judge` role which tools and skills fit a task. Each candidate becomes one yes/no question, sent in batches of 40. Returns up to `limit` matches (default 5) scoring at least 50%, best first. Judge cost is billed to the session.
  Put `/recommend-tools` anywhere in a prompt to run it on that prompt. The marker is removed before the prompt is sent. The picks go to the agent as a visible message ahead of the turn. The tool toggle switches the marker off too.
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
