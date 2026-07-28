# mjloop web — design

A browser dashboard that queues loop runs, shows each one in a real terminal,
and reads its progress from `.mjloop/`.

## Problem

Running the loop today means one terminal, one story, one person watching it.
Building a plan's worth of stories means sitting through each `/mjloop:build`,
noticing it finished, and typing the next one. Nothing about that is hard; all
of it is attention the person could spend elsewhere.

## What it does

`mjloop-web` serves a local page with three things on it:

- **A queue.** Each entry is one loop command. They run strictly one at a time.
- **A terminal.** The running job's `claude` session, unmodified — same TUI,
  same colours, same prompts. Two-way: you can type into it from the browser.
- **A state panel.** Track, cycle, stage, findings, plans, stories — read from
  `.mjloop/`, never inferred from terminal output.

The terminal is what the run *looks like*. `.mjloop/` is what the run *is*.
Keeping those separate is the design's load-bearing decision; everything below
follows from it.

## Non-goals

- **Parallel runs.** `state.json` holds one run. Two concurrent loops in one
  project corrupt it. The queue enforces sequence in code, not by convention.
- **Remote access.** Localhost only. This process spawns `claude` with the
  user's credentials on the user's machine.
- **Replacing the CLI.** Anything the page does, a person can do in a terminal.
  The page saves attention, not capability.

## Placement

Everything lives in `engine/`, shipped with the plugin:

```
engine/src/web/
  cli.ts          entry point for the mjloop-web bin
  server.ts       http + websocket, static assets, token auth
  queue.ts        sequential job queue
  session.ts      LoopSession interface, PtySession implementation
  completion.ts   pure: has this job finished?
  snapshot.ts     .mjloop/ -> dashboard payload
  protocol.ts     message types shared by server and page
  public/
    index.html
    app.js
    app.css
    locales/en.json
    locales/ar.json
engine/scripts/copy-web-assets.mjs
commands/web.md   the /mjloop:web slash command
```

New dependencies: `node-pty` (native), `ws`, and `@xterm/xterm` +
`@xterm/addon-fit` (browser assets, copied into `dist` at build time). The
package goes from three dependencies to seven. That is the price of the
feature and is stated plainly rather than buried.

`package.json` gains `"mjloop-web": "./dist/web/cli.js"` under `bin`, and the
build becomes `tsc && node scripts/copy-web-assets.mjs`.

## Launching it

Primary, matching the plugin's idiom:

```
/mjloop:web
```

The command starts the server in the background and prints its URL. Direct
invocation, for people who want it outside a Claude session:

```
node <plugin-root>/engine/dist/web/cli.js --dir . --port 4177
```

Flags: `--dir` (default cwd), `--port` (default 4177, `0` for any free port),
`--no-open`. The server exits when `.mjloop/` is absent, naming `/mjloop:init`.

## Security

The page can spawn processes. That makes its URL a credential.

- Bind `127.0.0.1` only, never `0.0.0.0`.
- Generate a 32-byte random token per server start. Every HTTP request and the
  WebSocket handshake must carry it. Requests without it get 401 before any
  handler runs.
- The token is in the printed URL's query string and nowhere on disk.

Without the token any page in the user's browser could POST to
`localhost:4177` and run arbitrary loop commands.

## Jobs and the queue

```ts
type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface Job {
  id: string
  command: string        // "/mjloop:build P001-S02"
  status: JobStatus
  exitCode: number | null
  startedAt: string | null
  endedAt: string | null
}
```

A job is one loop command. Enqueueing happens two ways — clicking a story
(which enqueues `/mjloop:build <id>`) or typing into the free command field.
Both produce the same thing, so the page has one execution model rather than a
queue model beside a launcher model.

The queue runs head-first, one at a time. When a job reaches a terminal status
the next one starts in a **fresh `claude` process** — a clean context per
story, which is the property that makes long queues behave.

A failed job stops the queue by default. The remaining jobs stay `queued` so
the user can look at what happened and resume, rather than returning to find
the failure repeated fifteen times.

## Detecting that a job finished

This is the part that is not obvious.

`claude "/mjloop:build P001-S02"` opens the interactive TUI and submits the
command. **It does not exit when the run ends** — it sits waiting for the next
message. So process exit cannot drive the queue.

`.mjloop/state.json` drives it. The run's status moving from `running` to
`done`, `halted`, or `failed` is the completion signal:

```
PTY output ─────────────────────────→ what you see
state.json status ──────────────────→ what advances the queue
```

Shutdown sequence once a terminal status is observed:

1. Write `/exit\r` to the PTY.
2. Wait up to 10s for a clean exit.
3. `SIGTERM`, wait 3s.
4. `SIGKILL`.

Three cases that are not "the run ended":

- **The process exits on its own** (bad command, crashed `claude`, user killed
  it). The job is `failed` with the exit code.
- **The run never starts.** No status transition, process alive, no output.
  Covered by the stall detector below.
- **`state.json` unreadable.** `stateSummary` already falls back to `.bak` and
  reports `recovered`. A recovered summary is *not* trusted to end a job — it
  may describe the write before last. The job continues; the stall detector
  catches it if the run really did end.

### Stall detection

`config.yaml` ships `autonomous: false`, which means the Stop hook does not
keep the session going between cycles: it can end its turn mid-run and wait for
a human. A queue that cannot notice this hangs forever on job one.

The server tracks the timestamp of the last byte out of the PTY. When status is
`running` and nothing has been written for 90 seconds, the page shows a stalled
banner with a **Continue** button that writes a nudge into the session. No
guessing, no automatic input — a notice and a button. The banner also names
`autonomous: true` as the way to stop seeing it.

## Reading state

One poller, every 800ms, builds a snapshot:

```ts
interface Snapshot {
  project: string
  state: StateSummary            // reused from ops/summary.ts
  plans: PlanView[]              // id, title, approval, stories from manifest.json
  runs: string[]                 // run directory names, newest first
  queue: Job[]
  session: { jobId: string | null; stalledSince: string | null }
}
```

Polling rather than `fs.watch`: recursive watch is unsupported on Linux, and
reading a handful of small files under a second is free next to the cost of
running `claude`. The snapshot reuses `stateSummary()` and each plan's
`manifest.json` — the page never parses `.mjloop/` formats itself, so a schema
change in the engine cannot leave the page reading stale shapes.

The snapshot is broadcast over the WebSocket when it differs from the last one
sent.

## Internationalisation

English is the base and the fallback. Arabic ships with it. Fifteen languages
later must cost one file each — which requires one commitment now:

**The server never emits human-readable prose.** Every message it sends is a
code plus parameters:

```ts
{ code: 'job.failed.exit', params: { code: 1 } }
```

The page renders it. Given this up front, adding a language is a JSON file and
one registry line; given it up late, it is an audit of every string in the
server. There is no cheap version of this decision made later.

- `public/locales/<lang>.json`, flat dot-namespaced keys (`queue.empty`,
  `state.cycle`, `job.failed.exit`).
- A small `t(key, params)` in the page. No library. Missing keys fall back to
  English rather than rendering blank.
- A registry carries each locale's direction:
  `{ en: { name: 'English', dir: 'ltr' }, ar: { name: 'العربية', dir: 'rtl' } }`
- `dir` is set on `<html>`. **The terminal container is pinned `dir="ltr"`
  always.** `claude`'s output is full of box drawing and column alignment;
  mirroring it makes it unreadable.
- Numbers and dates go through `Intl` with the active locale.
- Locale is chosen from `navigator.languages`, overridden by a switcher
  persisted in `localStorage`, and forceable with `?lang=ar` for testing.

A test asserts every locale file has exactly the key set of `en.json` — none
missing, none extra. That test is what keeps fifteen languages from rotting.

## Page

Single page, vanilla JavaScript, no framework and no bundler. `engine` builds
with `tsc` alone today and one screen does not justify a toolchain.

```
┌────────────────┬──────────────────────────────┐
│ track: build   │  ● P001-S02                  │
│ cycle 3 / 5    │  ┌────────────────────────┐  │
│ findings: 1 ⚠  │  │  xterm.js — the live   │  │
│                │  │  session, unmodified   │  │
│ P001 Auth      │  └────────────────────────┘  │
│  ✓ S01         │  [stop] [skip] [clear]       │
│  ● S02  ←      │  ┌────────────────────────┐  │
│  ○ S03         │  │ /mjloop:fix …          │  │
│ queue (2)      │  └────────────────────────┘  │
└────────────────┴──────────────────────────────┘
```

Keystrokes in the terminal go over the WebSocket to the PTY. That is how tool
permission prompts get approved and how a stuck cycle gets nudged without
tearing anything down.

Finished jobs keep their transcript in a bounded in-memory ring buffer
(1MB each, 20 jobs) so you can look at what happened. Transcripts are not
written to disk: `.mjloop/runs/` already holds the run's durable evidence, and
a second copy of the same thing with different retention rules is a liability.

## Testing

`session.ts` defines the seam:

```ts
interface LoopSession {
  write(data: string): void
  onData(fn: (chunk: string) => void): void
  onExit(fn: (code: number) => void): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
```

`PtySession` wraps `node-pty`. `FakeSession` is a scriptable stand-in. The
queue depends on the interface, so its whole state machine is testable without
spawning anything.

Covered:

- **queue** — sequencing, one-at-a-time enforcement, cancel, skip, a failure
  halting the queue, fresh session per job.
- **completion** — `isComplete(prev, next)` as a pure function over summaries,
  including the recovered-summary case that must not end a job.
- **stall** — idle threshold crossed while running, not crossed when output
  keeps arriving, never fires when the run is not `running`.
- **snapshot** — built from a fixture `.mjloop/` including a plan with stories.
- **auth** — no token is 401, wrong token is 401, on both HTTP and WebSocket.
- **locales** — `ar.json` key set equals `en.json` key set.

Following the existing suite: vitest, `makeTmpProject` from
`tests/helpers/tmp-project.ts`, tests under `engine/tests/web/`.

## Risks

- **`node-pty` is a native dependency.** `dist/` and `node_modules/` are not
  committed, so installers already build. This adds a compile step to that
  build. Prebuilt binaries cover common platforms; the rest need a toolchain.
- **The completion signal is indirect.** If a track ever ends without a status
  transition, the queue waits on the stall detector rather than advancing. That
  degrades to "a human notices", which is the correct failure direction.
- **Interactive `claude` invocation is a surface we do not own.** If the CLI
  changes how a prompt argument is passed, this breaks. Confined to one call
  site in `session.ts`.
