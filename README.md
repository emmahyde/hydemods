# Hydemods

Hydemods is a small visual registry of composable tweaks for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). It adds a `/hydemods` panel where you can inspect and toggle the bundled session improvements.

## Included tweaks

All of these tweaks start enabled and can be toggled from the panel:

- **Integrated tool expansion** — formats structured tool results for compact and expanded display, including syntax-colored JSON and YAML.
- **Map tool results to TOON** — encodes structured JSON/YAML tool results as TOON before display.
- **Session identity & colors** — gives each session a persistent codename, sigil, and ANSI accent color.
- **Last prompt drawer** — shows a truncated preview of the latest prompt above the editor.
- **IRC comms & System Monitor** — enables session communication and deterministic background monitors over the IRC bus.
- **Autonomous `/heartbeat` exploration** — adds `/heartbeat` for self-directed exploration and goal-setting.
- **Interactive `/retro` summary** — adds `/retro` for a structured session retrospective.

## Install and use in OMP

OMP discovers direct extensions in `~/.omp/agent/extensions`. Clone or copy this repository there, install its dependencies, and restart OMP:

```sh
git clone https://github.com/emmahyde/hydemods.git ~/.omp/agent/extensions/hydemods
cd ~/.omp/agent/extensions/hydemods
bun install
```

The included `package.json` declares `./index.ts` through OMP's `omp.extensions` metadata. Open `/hydemods` in an OMP session to view and toggle the tweaks.

## Development

This package uses Bun and has no build step or project scripts. From the repository root:

```sh
bun install
bun pm ls --all
bun -e 'const m = await import("./index.ts"); if (typeof m.default !== "function") throw new Error("invalid extension factory")'
```

Edit `index.ts` directly, then restart OMP (or reload the extension in your development workflow) to try changes.
