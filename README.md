# Hydemods

Hydemods is a small visual registry of composable tweaks for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It adds a `/hydemods` panel where you can inspect and toggle the bundled session improvements.

One line, with [Bun](https://bun.sh) and git on your PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/emmahyde/hydemods/main/install.sh | sh
```

- This clones the repository into `~/.omp/agent/extensions/hydemods` (where OMP discovers directory extensions), installs its dependencies, and updates an existing checkout on re-run. 
- Set `HYDEMODS_DIR` to install elsewhere.
- Restart OMP or run `/reload-plugins`, and open `/hydemods` to view and toggle the tweaks.

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

- **Integrated tool cards** — draws structured tool results inside OMP's own tool card. Reads show the file's declaration outline; edits show the declarations they touched, with the changed lines and any LSP diagnostics on Ctrl+O.
- **TOON for the model** — hands JSON tool results (including MCP server JSON responses and fenced ```` ```json ```` blocks) to the model as TOON (Token-Oriented Object Notation), a compact table-like form that costs far fewer tokens than JSON; you still see OMP's JSON tree.
- **Session title** — names the session once from the first prompt and locks it; `/rename` still overrides.
- **Last prompt drawer** — shows a preview of your latest prompt above the editor.
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
