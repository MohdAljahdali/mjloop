# Contributing to mjloop

Thanks for taking the time. This document covers how to build the plugin, how to test a
change, and what a reviewable pull request looks like here.

## Setup

Node 20 or newer is required (`engines.node: >=20`).

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
```

To use your working copy inside Claude Code, add the repository root as a local plugin or
plugin marketplace. The MCP server is served from `engine/dist/mcp/server.js`, so
`npm run build` must have run before the plugin will load.

`engine/dist/` is committed, and that is deliberate. A plugin ships what is in git and
runs it as-is — there is no install step on the user's machine — so a repository holding
only `src/` installs a plugin whose MCP server and hooks point at files that do not
exist. `npm run build` bundles every dependency in, so the shipped tree needs no
`node_modules` at all. `node-pty` is the one exception: it is native, only the dashboard
uses it, and `/mjloop:web` installs it on first run.

The practical consequence: **rebuild before you commit**, and expect a release commit to
carry `engine/dist/` changes alongside the source. A `dist/` that lags `src/` is a
release that ships yesterday's behaviour.

Enable the repository's git hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## Versioning

`/plugin` decides whether an update exists by comparing the `version` in
`.claude-plugin/plugin.json`. A push that changes behaviour but leaves the version alone
reaches GitHub and is still invisible to every installed copy.

So every push to `main` bumps the version, in `.claude-plugin/plugin.json` and
`engine/package.json` together, by what changed:

| Change                     | Bump  |
| -------------------------- | ----- |
| Breaking change            | major |
| `feat`                     | minor |
| `fix`, `chore`, `refactor` | patch |

The `.githooks/pre-push` hook enforces this: it refuses a push to `main` whose version
already exists on the remote, and refuses one where the two files disagree. For a change
that genuinely ships nothing to users — a docs-only commit, a CI tweak — `git push
--no-verify` is the deliberate way past it.

## Repository layout

| Path              | What lives there                                                       |
| ----------------- | ---------------------------------------------------------------------- |
| `engine/`         | The TypeScript engine: MCP server, CLI, schemas, state store            |
| `agents/`         | One markdown file per agent, each bound by the `mjloop-contract` skill  |
| `commands/`       | The `/mjloop:*` slash commands                                          |
| `skills/`         | The skills the leader and the agents read                              |
| `hooks/`          | Hook definitions and their scripts                                      |
| `tests/`          | End-to-end smoke tests and their fixtures                               |
| `docs/`           | Design documents and implementation plans, one per milestone            |

Unit and integration tests live under `engine/`; the shell-driven smoke tests live under
`tests/e2e/`.

## The cockpit (`engine/src/web/app/`)

The dashboard is a Vue 3 + TypeScript + Vite app, built to `engine/dist/web/public/` — not
a hand-written page. `npm run dev` (from `engine/`) starts Vite's dev server against a
`mjloop-web` you already have running; set `MJLOOP_DEV_ORIGIN` to the origin it printed so
Vite's `/api` proxy (`vite.config.ts`) reaches it — the WebSocket connects to that origin
directly and needs no proxy. `npm run build` compiles the app and is what `dist/` in git
must always match; `node scripts/verify-ship.mjs` is the byte-for-byte check.

`vendor/` (xterm and its fit addon) is resolved from `node_modules` at build time and
copied in rather than bundled through Vite — `scripts/vendor.mjs` is the one list shared
by `scripts/build.mjs` and `verify-ship.mjs`, so the two cannot drift. `engine/src/web/*.ts`
(the server, protocol, api, writes) is the one boundary the cockpit never crosses in
either direction — the app only ever talks to it over the API and the socket.

## Verifying a change

Run all three from `engine/`:

```bash
npm test           # unit and integration tests (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # required whenever engine source changed
```

The seven smoke tests drive the real CLI and are opt-in, since each one spends tokens:

```bash
LOOP_E2E=1 npm run e2e         # edit track
LOOP_E2E=1 npm run e2e:build   # build track
LOOP_E2E=1 npm run e2e:fix     # fix track
LOOP_E2E=1 npm run e2e:story   # build track against a story
LOOP_E2E=1 npm run e2e:plan    # plan track
LOOP_E2E=1 npm run e2e:design  # design-sync
LOOP_E2E=1 npm run e2e:add     # /mjloop:add scaffolding
```

Run the smoke test that covers the track you touched. Say in the pull request which ones
you ran and what they printed — a claim that something passes is only worth the output
behind it.

## Adding an agent, a skill, or a track

Use the scaffold rather than hand-copying an existing file:

```
/mjloop:add agent|skill|track <name>
```

Read the `mjloop-extend` skill first: it explains where each element lives and what a new
agent must return. Read `mjloop-contract` before writing an agent — every agent receives
the same brief and must return the same output shape, and the engine enforces it. None of
these additions should require an engine change; if yours does, say why in the pull
request.

## Commit messages

Conventional Commits, with an optional scope naming the area:

```
feat(mcp): expose the three memory tools
fix(engine): rename the CLAUDE.md section marker to mjloop
test(e2e): prove what the scaffold can prove, and say what it cannot
docs: record the rename from loop to mjloop
```

Common types here: `feat`, `fix`, `refactor`, `test`, `docs`. Keep each commit atomic —
one reviewable change, with its tests in the same commit.

## Pull requests

- Branch off `main` and open the pull request against `main`.
- Describe what changed and why, not just what files moved.
- Include the output of the checks you ran.
- If you changed behavior a document describes, update that document in the same pull
  request. Stale docs are a defect here, not a follow-up.

## Reporting a bug

Open an issue with the track you were running, the command you invoked, what you expected,
and what happened. If `.mjloop/` in the affected project holds a run report or evidence
from the failing cycle, include it — that is usually the whole diagnosis.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
