# Installing mjloop

> النسخة العربية: [install.ar.md](./install.ar.md)

## Requirements

- **Claude Code** — the CLI, desktop app, or IDE extension.
- **Node.js 20 or newer.** The engine is an ESM TypeScript package; `node --version` must
  report at least `v20`.
- **git**, for the `build` and `fix` tracks, which commit each passing cycle.

## Install

### 1. Build the engine

The MCP server and the hook CLI run from compiled output, and `engine/dist/` is not
committed — so a fresh clone must build once before anything works.

```bash
cd /path/to/mjloop/engine
npm install
npm run build
```

Confirm it produced both entrypoints:

```bash
ls dist/mcp/server.js dist/cli/index.js
```

### 2. Register the repository as a marketplace

```bash
claude plugin marketplace add /path/to/mjloop
```

The path is registered as-is: the marketplace's install location **is** your repository,
not a copy. Rebuilding the engine takes effect immediately, with no reinstall.

### 3. Install the plugin

```bash
claude plugin install mjloop@mjloop
```

The same two steps work inside a session as `/plugin marketplace add <path>` and
`/plugin install mjloop@mjloop`.

## Verify

```bash
claude plugin list          # expect: mjloop@mjloop — enabled
claude mcp list             # expect: plugin:mjloop:mjloop — ✔ Connected
claude plugin details mjloop@mjloop
```

The last command prints the component inventory. A correct install reports **Agents (19)**,
**Skills (15)** — the CLI counts the 10 commands and the 5 skills in one bucket — and
**Hooks (3)**. `MCP servers (0)` in that listing is expected; see Troubleshooting, and
treat `claude mcp list` as the check that matters for the server.

The always-on context cost is small. The `PreToolUse` and `Stop` hooks add nothing to the
model's context. The `SessionStart` hook adds one line — the `Loop: …` state summary — and
only in a project that has a `.mjloop/` directory.

If `claude mcp list` does not show the server as connected, the usual cause is a missing
build: check `engine/dist/mcp/server.js` exists and re-run `npm run build`.

## What gets installed where

| Where | What |
|---|---|
| Your repository | Everything. The marketplace points at it directly. |
| `~/.claude/plugins/` | A registry entry naming your path — `known_marketplaces.json` records `installLocation` as your repository — plus a snapshot copy of the whole tree under `~/.claude/plugins/cache/`. The copy is not what runs. |
| Your project, after `/mjloop:init` | `.mjloop/` and a section appended to `CLAUDE.md` |

Nothing is written into a project until you run `/mjloop:init` there.

## Updating

Pull, rebuild, and refresh the marketplace:

```bash
git -C /path/to/mjloop pull
cd /path/to/mjloop/engine && npm install && npm run build
claude plugin marketplace update mjloop
```

Because the install location is the repository itself, a rebuild is usually all that is
needed — the marketplace update matters when the plugin's manifest, commands, agents, or
skills changed.

## Uninstalling

```bash
claude plugin uninstall mjloop@mjloop
claude plugin marketplace remove mjloop
```

Neither command touches your projects. A project's `.mjloop/` directory and its `CLAUDE.md`
section stay where they are; delete them by hand if you want them gone.

## Adding it to a project

In the project you want to work in:

```
/mjloop:init
```

That provisions `.mjloop/`, detects your verify commands from `package.json`, and appends
a short section to `CLAUDE.md` so any session in that project knows the plugin is there.

If a verify command cannot be detected, `/mjloop:init` asks you once. It will not invent
one: a fabricated verify command produces false passes, which is worse than no command at
all.

## Troubleshooting

**The commands do not appear.** Claude Code discovers a newly installed plugin within
seconds, but a directory that did not exist when the session started needs a restart.

**`MCP servers (0)` in `claude plugin details`.** A display limitation of some CLI
versions, not a defect — `claude mcp list` is the reliable check.

**A hook reports an error.** The hook scripts invoke `engine/dist/cli/index.js` by path.
If `dist/` is missing or stale, rebuild.

## Next

- [About](./about.md)
- [Usage](./usage.md)
