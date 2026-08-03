# mjloop

> Verified development cycles for Claude Code.

[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**English** · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Make coding agents prove they finished.**

`mjloop` is a Claude Code plugin that turns agent work into bounded, evidence-backed
cycles. A leader selects the right agents for the task, runs them in isolated contexts,
and accepts success only after the engine records the result of your project's own
verification commands.

`request → track → isolated agents → engine verification → evidence-backed result`

> [!IMPORTANT]
> `mjloop` currently supports Claude Code. Adapters for other coding agents are not part
> of the released plugin yet.

## Why mjloop?

- **Evidence, not confidence** — a passing claim cannot override a failing or missing
  engine receipt.
- **State agents cannot rewrite** — run state and generated manifests are owned by the
  MCP server, not edited by agents.
- **Bounded autonomy** — cycle, stagnation, and repeated-error guards stop work that is
  no longer making progress.
- **A workflow for each job** — use a short edit cycle, a multi-cycle build, a
  reproduction-first fix, or a reviewed planning flow.

## Quick start

You need Claude Code, Node.js 20 or newer, and Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Then open Claude Code in a project and run:

```text
/mjloop:init
/mjloop:edit add input validation to the signup form
```

> [!NOTE]
> A fresh clone must be built once because the MCP server and hook CLI run from
> `engine/dist/`. See the [complete installation guide](docs/install.md) for verification,
> updates, and troubleshooting.

## Pick the right track

| Command | Best for | Built-in rule |
|---|---|---|
| `/mjloop:edit <request>` | Small, focused changes | One cycle; escalate if the scope grows |
| `/mjloop:build <goal>` | Features and larger implementation | Repeat verified cycles until done or halted |
| `/mjloop:fix <problem>` | Defects and regressions | Reproduce the failure before accepting a fix |
| `/mjloop:plan <idea>` | Turning an idea into buildable stories | Fit check and approval before story creation |

A track that has none of these four commands still runs: `/mjloop:run <track> <goal>` opens
any track named in `config.yaml`, so a track added from the dashboard's Tracks tab is not
stuck without a way to start it.

Use `/mjloop:status` to inspect the current run, `/mjloop:resume` to continue an
interrupted run, `/mjloop:stop` to halt it, and `/mjloop:web` to open the browser cockpit.

## What happens in a cycle?

1. The leader composes a roster from the selected track and records why each optional
   specialist was included or omitted.
2. Contract-bound agents work in isolated contexts with focused responsibilities.
3. The engine runs the verification commands pinned when the run started and stores the
   full log outside the agent's narrative.
4. Failed verification becomes input to the next cycle; a passing receipt can close the
   run.
5. Safety guards halt cycles that hit their limit, stagnate, or repeat the same failure.

## More than execution

- **Feature discovery** — the `mjloop-feature-discovery` skill interviews one decision at
  a time and stops at a brief a person can approve.
- **Project-aware routing** — accepted component maps and skills guide fixed agent roles
  without changing an in-flight run.
- **Browser cockpit** — inspect runs, plans, stories, evidence, configuration, and memory
  with `/mjloop:web`.
- **Extensible tracks** — add an agent, skill, or track with `/mjloop:add`.

> [!TIP]
> Start with `/mjloop:edit` for a real, contained change. It is the quickest way to see
> the verification contract without paying for a multi-cycle run.

## Read next

- [Why mjloop exists](docs/about.md)
- [Installation and troubleshooting](docs/install.md)
- [Commands, configuration, and workflows](docs/usage.md)
- [Arabic documentation](docs/about.ar.md)

If `mjloop` solves a problem you recognize, consider starring the repository so other
developers can find it.
