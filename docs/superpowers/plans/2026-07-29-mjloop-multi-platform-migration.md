# mjloop Multi-Platform Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert mjloop from a Claude Code-only plugin into one shared cycle engine that runs on Claude Code, Codex, Gemini CLI, and OpenCode without removing or weakening any existing mjloop feature.

**Architecture:** Keep `.mjloop/`, the TypeScript engine, the MCP API, verification, plans, stories, memory, telemetry, and the cockpit as the platform-neutral control plane. Move host-specific commands, agents, skills, hooks, project instructions, installation paths, process launch arguments, and continuation behavior behind versioned platform adapters generated from one canonical definition set. Preserve Claude Code as the reference adapter and require it to pass a compatibility gate before any other adapter can ship.

**Tech Stack:** Node.js 20+, TypeScript 5.9, Zod 4, Model Context Protocol SDK, Vitest, esbuild, YAML, `node-pty`, shell-based real-runtime smoke tests.

## Global Constraints

- This is a migration, not a rewrite. Existing `.mjloop/` project state must remain readable and writable without a manual migration.
- Claude Code behavior is the compatibility reference. No Claude command, agent, skill, hook, MCP tool, cockpit action, safety guard, or release path may disappear.
- The migration must preserve all current `plan`, `build`, `fix`, and `edit` tracks and their exact required/available/closing semantics.
- The migration must preserve the cycle cap, stagnation guard, repeated-error guard, reproduction gate, fit-check gate, plan-approval gate, commit gate, preflight gate, verification pinning, verification cache rules, and engine-owned evidence validation.
- The migration must preserve all 12 shipped commands, 19 shipped agents, 5 shipped skills, at least the 18 existing MCP tools, and 3 Claude lifecycle hooks present at the start of this plan.
- The migration must preserve memory, plans, stories, generated manifests/indexes, design-system extraction, specialists, telemetry, history, preflight estimation, handoffs, maps, verify logs, and closing agents.
- The cockpit must remain localhost-only, token-protected, bounded in transcript retention, sequential per project, and capable of plan approval, story requeue, halt, terminal input, cancellation, resume, and queue management.
- A platform adapter may use an equivalent safety mechanism when the host lacks a Claude feature, but it may not silently claim support. Unsupported required capabilities must produce an actionable refusal.
- Existing Claude marketplace installation remains supported throughout the migration. It is not removed when the universal installer appears.
- Generated-file installation and removal must be transactional, hash-aware, path-safe, and non-destructive. Never overwrite or delete a user-modified file without an explicit conflict decision.
- Installing, upgrading, or uninstalling a platform integration must never delete `.mjloop/`, plans, stories, runs, memory, design-system data, or user-authored project files.
- Installing a platform integration must not create or initialize `.mjloop/`; only `mjloop init` creates engine state.
- Platform choice is per invocation or per cockpit job. Do not persist one platform into `state.json`; the same project may be opened by more than one supported host.
- Keep platform names stable: `claude-code`, `codex`, `gemini-cli`, and `opencode`.
- Keep logical mjloop command ids stable: `init`, `edit`, `plan`, `build`, `fix`, `status`, `stop`, `resume`, `design-sync`, `web`, `add`, and keep `release` as a repository-maintenance command.
- Keep host command spelling stable and generated from adapter metadata: Claude Code `/mjloop:<id>`, Codex `$mjloop-<id>`, Gemini CLI `/mjloop:<id>`, and OpenCode `/mjloop-<id>`.
- Keep logical MCP tool names stable as `mjloop_*`. An adapter may map a host-visible qualified name to the logical name, but engine code must not learn host-specific qualification.
- Keep canonical agent reasoning levels provider-neutral: `standard` and `deep`. Platform adapters map those levels to supported model configuration; canonical definitions must not name `sonnet`, `opus`, or a vendor model id.
- Keep all engine invariants enforced in TypeScript/Zod. Prompts explain invariants but are never their only enforcement.
- Preserve Node.js `>=20` and the existing TypeScript, Zod, MCP SDK, Vitest, esbuild, YAML, WebSocket, and optional `node-pty` stack unless a separately approved change says otherwise.
- Do not regenerate `engine/dist/**` until the current Milestone 8 working tree is completed, reviewed, and committed. The working tree was dirty when this plan was authored.
- Do not begin Task 2 until Task 1 records a clean, green baseline. During plan authoring, typecheck passed and 1,099 tests passed, but the aggregate run failed because `tests/ops/zz-union-flag-repro.test.ts` disappeared during discovery; that transient suite failure must be resolved before migration work starts.
- Every implementation task follows TDD: add the focused failing test, confirm the failure reason, implement the smallest behavior, run focused tests, run the phase gate, and commit only that task.
- Every platform adapter must be tested at three levels: pure renderer/runtime unit tests, a staged-install test in a temporary home/project, and an opt-in smoke test against the real host CLI.
- Documentation and generated artifacts remain English, matching the repository’s implementation-document convention. Arabic user documentation is updated alongside English user documentation where an Arabic counterpart already exists.

---

## 1. Scope and Feature-Preservation Contract

### In scope

1. A platform-neutral engine and project-state layer.
2. Canonical, host-neutral definitions for commands, agents, and skills.
3. A platform registry and capability model.
4. A Claude Code adapter that reproduces current behavior.
5. A Codex adapter.
6. A Gemini CLI adapter.
7. An OpenCode adapter.
8. A universal installer with local/global and multi-platform selection.
9. Platform-aware cockpit launch and diagnostics.
10. Cross-platform project extensions created by `mjloop add`.
11. Cross-platform build, staged-package verification, smoke tests, docs, and release checks.

### Explicitly out of scope

1. Integrating GSD, BMAD, or any other workflow framework into mjloop.
2. Calling provider HTTP APIs directly from the engine.
3. Choosing one AI model provider for all platforms.
4. Replacing `.mjloop/` with a database or remote service.
5. Remote cockpit access.
6. Running two mjloop jobs concurrently against the same project state.
7. Cursor and GitHub Copilot adapters in the first release. The contracts must allow them, but they are separate follow-up adapters after the four target platforms pass.

### Current feature contract

The implementation must create a machine-readable contract and keep this table synchronized with it.

| Capability | Current Claude behavior | Required multi-platform outcome |
|---|---|---|
| Init | Creates `.mjloop/`, detects verify scripts, appends Claude instructions | Same engine state; adapter writes/merges the correct host instructions |
| Edit | One scoped editor/verifier cycle with escalation | Identical logical track and engine gates |
| Plan | Planner, fit-check, approval, stories, reviews | Identical logical track and artifacts |
| Build | Repeated verified cycles, story/direct goal, optional specialists, closing docs | Identical logical track and artifacts |
| Fix | Reproduction before fixer, investigation/hypotheses, verification | Identical gate and evidence rules |
| Status | State, evidence, design system, config error, telemetry, preflight/history | Same logical data; host-specific command spelling only |
| Stop/resume | Clean halt/requeue and exact open-cycle continuation | Same state transitions; adapter-specific continuation |
| Design sync | Reads the real product design system | Same output and blocking behavior |
| Add | Scaffolds agent/skill/track and prevents shipped-name shadowing | Canonical extension plus generated platform artifacts |
| Release | Clean-tree/version/build/ship checks for Claude plugin | Versioned matrix release while preserving Claude marketplace release |
| MCP state owner | All protected state writes pass through MCP/engine | Same logical ownership; hook or tamper detector blocks silent corruption |
| Autonomous | Claude Stop hook continues bounded work | Native hook or process supervisor with the same engine termination conditions |
| Cockpit | Local tokenized web UI plus PTY and queue | Same UI/actions with a platform selector and adapter diagnostics |
| Packaging | Bundled engine runs without `node_modules`; PTY installs on demand | Same guarantee for every generated platform package |

## 2. Target Architecture

```text
Canonical definitions
  commands + agents + skills + feature contract
                     |
                     v
            Definition compiler
                     |
      +--------------+--------------+----------------+
      |              |              |                |
 Claude renderer  Codex renderer  Gemini renderer  OpenCode renderer
      |              |              |                |
 Claude plugin    Codex skills    Gemini extension  OpenCode config/plugin
      +--------------+--------------+----------------+
                     |
                     v
              Platform registry
      runtime + capabilities + installer + lifecycle
                     |
                     v
       Shared TypeScript engine / MCP / verification
                     |
                     v
       .mjloop state, plans, runs, memory, evidence
```

### Platform capability policy

The code must distinguish:

- `native`: the host provides the capability directly.
- `emulated`: mjloop supplies an equivalent mechanism.
- `unsupported`: the operation is refused before starting.

The first release targets this matrix:

| Capability | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Project instructions | Native `CLAUDE.md` | Native `AGENTS.md` | Native `GEMINI.md`/extension context | Native `instructions` config |
| Commands/skills | Native plugin commands/skills | Generated Agent Skills | Extension commands/context | Generated commands/skills |
| Subagents | Native Agent tool | Adapter capability probe | Adapter capability probe | Native agents |
| Per-agent reasoning/model routing | Native agent model frontmatter | Native flag/config or emulated child setting | Native config or emulated child setting | Native agent model config |
| Per-agent tool policy | Native agent tool frontmatter | Native sandbox/policy or emulated child policy | Native agent/tool config or guarded child | Native agent permission config |
| MCP | Native plugin MCP | Native configured MCP | Native extension MCP | Native config MCP |
| Session-start context | Native hook | Emulated in launch prompt | Native hook | Emulated plugin event/prompt |
| Protected-write interception | Native `PreToolUse` | Tamper detection plus host policy when available | Native `BeforeTool` | Native `tool.execute.before` |
| Autonomous continuation | Native Stop hook | Process supervisor | Native hook or supervisor | Process supervisor |
| Interactive PTY | Native `claude` | Native `codex` | Native `gemini` | Native `opencode` |
| Headless smoke execution | `claude -p` | `codex exec` | Headless Gemini invocation | `opencode run` |

Capability probes, not this table alone, decide what a detected version may use.

### External compatibility references

Adapter implementation must re-check these official sources at the start of its task because host CLI surfaces can change independently of mjloop:

- Codex: `https://github.com/openai/codex` — `AGENTS.md`, Agent Skills, MCP configuration, interactive CLI, `codex exec`, and session continuation.
- Gemini CLI extension reference: `https://github.com/google-gemini/gemini-cli/blob/v0.39.1/docs/extensions/reference.md`.
- Gemini CLI hooks: `https://github.com/google-gemini/gemini-cli/blob/v0.39.1/docs/hooks/writing-hooks.md`.
- OpenCode configuration and commands: `https://github.com/anomalyco/opencode/tree/dev/packages/web/src/content/docs`.
- OpenCode plugin hooks: `https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts`.

These links are verification inputs, not permission to hard-code one version forever. Each adapter descriptor records the minimum tested version, detection reports the installed version, and capability probes refuse or emulate behavior when the installed host differs.

## 3. Locked File Structure

The migration should converge on this structure:

```text
definitions/
├── catalog.yaml
├── commands/
│   ├── add.md
│   ├── build.md
│   ├── design-sync.md
│   ├── edit.md
│   ├── fix.md
│   ├── init.md
│   ├── plan.md
│   ├── release.md
│   ├── resume.md
│   ├── status.md
│   ├── stop.md
│   └── web.md
├── agents/
│   ├── builder.md
│   ├── critic.md
│   ├── docs.md
│   ├── editor.md
│   ├── fit-checker.md
│   ├── fixer.md
│   ├── hypothesis-tester.md
│   ├── investigator.md
│   ├── perf.md
│   ├── plan-critic.md
│   ├── planner.md
│   ├── reproducer.md
│   ├── scout.md
│   ├── security.md
│   ├── story-critic.md
│   ├── story-writer.md
│   ├── ui-critic.md
│   ├── ui-designer.md
│   └── verifier.md
└── skills/
    ├── mjloop-contract/SKILL.md
    ├── mjloop-extend/SKILL.md
    ├── mjloop-leader/SKILL.md
    ├── mjloop-state/SKILL.md
    └── mjloop-tracks/SKILL.md

platforms/
├── feature-contract.json
├── claude-code/
│   ├── descriptor.json
│   └── static/
├── codex/
│   ├── descriptor.json
│   └── static/
├── gemini-cli/
│   ├── descriptor.json
│   └── static/
└── opencode/
    ├── descriptor.json
    └── static/

engine/src/platform/
├── ids.ts
├── capabilities.ts
├── adapter.ts
├── registry.ts
├── errors.ts
├── definitions/
│   ├── schema.ts
│   ├── load.ts
│   ├── compile.ts
│   └── tokens.ts
├── install/
│   ├── schema.ts
│   ├── plan.ts
│   ├── apply.ts
│   ├── merge.ts
│   ├── receipt.ts
│   └── paths.ts
├── runtime/
│   ├── invocation.ts
│   ├── session.ts
│   ├── agent-dispatch.ts
│   ├── supervisor.ts
│   └── tamper.ts
└── adapters/
    ├── claude-code/
    ├── codex/
    ├── gemini-cli/
    └── opencode/

engine/tests/platform/
├── feature-contract.test.ts
├── registry.test.ts
├── definitions.test.ts
├── install.test.ts
├── agent-dispatch.test.ts
├── supervisor.test.ts
├── tamper.test.ts
└── adapters/
    ├── claude-code.test.ts
    ├── codex.test.ts
    ├── gemini-cli.test.ts
    └── opencode.test.ts

tests/e2e/
├── run-platform-smoke.sh
├── platform-claude.sh
├── platform-codex.sh
├── platform-gemini.sh
└── platform-opencode.sh
```

Existing root `commands/`, `agents/`, `skills/`, `hooks/`, and `.claude-plugin/` remain the generated and reviewable Claude distribution. They are not deleted.

---

### Task 1: Freeze a Green Compatibility Baseline

**Files:**
- Create: `platforms/feature-contract.json`
- Create: `engine/src/platform/feature-contract.ts`
- Create: `engine/tests/platform/feature-contract.test.ts`
- Create: `docs/multi-platform-compatibility.md`
- Modify: `engine/package.json`

**Interfaces:**
- Consumes: current commands, agents, skills, MCP registrations, hooks, schemas, integration tests, cockpit tests, and Milestone 8 changes.
- Produces: `FeatureContract`, `loadFeatureContract()`, and `npm run test:compat` used by every later phase gate.

- [ ] **Step 1: Finish the current Milestone 8 branch before touching migration code**

Run:

```bash
git status --short
cd engine
npm test
npm run typecheck
npm run build
npm run verify:ship
```

Expected: the tree contains only the completed Milestone 8 change, all tests pass without a disappearing test file, typecheck passes, the bundle builds, and staged shipment verification passes. Commit Milestone 8 separately. Do not include migration files in that commit.

- [ ] **Step 2: Write the feature contract**

Create `platforms/feature-contract.json` with the exact baseline:

```json
{
  "schema_version": 1,
  "commands": [
    "add",
    "build",
    "design-sync",
    "edit",
    "fix",
    "init",
    "plan",
    "release",
    "resume",
    "status",
    "stop",
    "web"
  ],
  "agents": [
    "builder",
    "critic",
    "docs",
    "editor",
    "fit-checker",
    "fixer",
    "hypothesis-tester",
    "investigator",
    "perf",
    "plan-critic",
    "planner",
    "reproducer",
    "scout",
    "security",
    "story-critic",
    "story-writer",
    "ui-critic",
    "ui-designer",
    "verifier"
  ],
  "skills": [
    "mjloop-contract",
    "mjloop-extend",
    "mjloop-leader",
    "mjloop-state",
    "mjloop-tracks"
  ],
  "minimum_mcp_tool_count": 18,
  "claude_hooks": ["SessionStart", "PreToolUse", "Stop"],
  "tracks": ["plan", "build", "fix", "edit"],
  "protected_behaviors": [
    "state-owner",
    "atomic-write-and-backup",
    "cycle-cap",
    "stagnation-guard",
    "repeated-error-guard",
    "reproduction-gate",
    "fit-check-gate",
    "plan-approval-gate",
    "commit-gate",
    "preflight-gate",
    "verification-pinning",
    "engine-recorded-verification",
    "sequential-project-queue",
    "localhost-tokenized-cockpit"
  ]
}
```

- [ ] **Step 3: Write the failing contract test**

```ts
import { describe, expect, it } from 'vitest'
import { loadFeatureContract, scanClaudeDistribution } from '../../src/platform/feature-contract.js'

describe('feature compatibility contract', () => {
  it('matches the shipped Claude distribution', async () => {
    const expected = await loadFeatureContract()
    const actual = await scanClaudeDistribution()
    expect(actual.commands).toEqual(expected.commands)
    expect(actual.agents).toEqual(expected.agents)
    expect(actual.skills).toEqual(expected.skills)
    expect(actual.mcpToolCount).toBeGreaterThanOrEqual(expected.minimum_mcp_tool_count)
    expect(actual.claudeHooks).toEqual(expected.claude_hooks)
  })
})
```

Run:

```bash
cd engine
npx vitest run tests/platform/feature-contract.test.ts
```

Expected: FAIL because the feature-contract loader and scanner do not exist.

- [ ] **Step 4: Implement the schema-backed loader and distribution scanner**

Export:

```ts
export interface FeatureContract {
  schema_version: 1
  commands: string[]
  agents: string[]
  skills: string[]
  minimum_mcp_tool_count: number
  claude_hooks: string[]
  tracks: string[]
  protected_behaviors: string[]
}

export async function loadFeatureContract(): Promise<FeatureContract>
export async function scanClaudeDistribution(): Promise<{
  commands: string[]
  agents: string[]
  skills: string[]
  mcpToolCount: number
  claudeHooks: string[]
}>
```

Resolve repository resources relative to `import.meta.url`, not the current working directory.

- [ ] **Step 5: Add the compatibility script and documentation**

Add:

```json
{
  "scripts": {
    "test:compat": "vitest run tests/platform/feature-contract.test.ts tests/integration tests/cli tests/mcp tests/web"
  }
}
```

Document the feature table, the four target platforms, exact parity versus equivalent safety, and the rule that a red compatibility suite blocks the next adapter.

- [ ] **Step 6: Run the baseline gate**

```bash
cd engine
npm run test:compat
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add platforms/feature-contract.json engine/src/platform/feature-contract.ts engine/tests/platform/feature-contract.test.ts docs/multi-platform-compatibility.md engine/package.json
git commit -m "test(platform): freeze the Claude compatibility contract"
```

---

### Task 2: Define Platform IDs, Capabilities, and Adapter Contracts

**Files:**
- Create: `engine/src/platform/ids.ts`
- Create: `engine/src/platform/capabilities.ts`
- Create: `engine/src/platform/adapter.ts`
- Create: `engine/src/platform/errors.ts`
- Create: `engine/src/platform/registry.ts`
- Create: `engine/tests/platform/registry.test.ts`

**Interfaces:**
- Consumes: `FeatureContract`.
- Produces: `PlatformIdSchema`, `CapabilitySupportSchema`, `PlatformAdapter`, `PlatformRegistry`, and `createPlatformRegistry()`.

- [ ] **Step 1: Write registry tests that name every target platform and reject duplicates**

```ts
import { describe, expect, it } from 'vitest'
import { createPlatformRegistry } from '../../src/platform/registry.js'

describe('platform registry', () => {
  it('registers the four stable platform ids', () => {
    const registry = createPlatformRegistry()
    expect(registry.ids()).toEqual(['claude-code', 'codex', 'gemini-cli', 'opencode'])
  })

  it('refuses duplicate ids', () => {
    const registry = createPlatformRegistry()
    const claude = registry.get('claude-code')
    expect(() => registry.register(claude)).toThrow(/duplicate platform claude-code/)
  })
})
```

Run:

```bash
cd engine
npx vitest run tests/platform/registry.test.ts
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 2: Define the stable ids and capability support values**

```ts
import { z } from 'zod'

export const PlatformIdSchema = z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode'])
export type PlatformId = z.infer<typeof PlatformIdSchema>

export const CapabilitySupportSchema = z.enum(['native', 'emulated', 'unsupported'])
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>
```

Define these capability keys:

```ts
export const CapabilityKeySchema = z.enum([
  'project-instructions',
  'commands',
  'skills',
  'subagents',
  'per-agent-model-routing',
  'agent-tool-policy',
  'mcp',
  'session-start-context',
  'protected-write-interception',
  'autonomous-continuation',
  'interactive-pty',
  'headless-execution'
])
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>
```

- [ ] **Step 3: Define the adapter contract**

```ts
export interface PlatformDetection {
  installed: boolean
  binary: string | null
  version: string | null
  detail: string
}

export interface RuntimeInvocation {
  binary: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface AgentInvocationContext {
  cwd: string
  agentId: string
  instance: string | null
  brief: string
  resultSchemaPath: string
  reasoning: 'standard' | 'deep'
  capabilities: string[]
  env: NodeJS.ProcessEnv
}

export interface RenderedFile {
  relativePath: string
  content: string | Uint8Array
  mode: number
  ownership: 'managed' | 'merged'
}

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly displayName: string
  readonly capabilities: Readonly<Record<CapabilityKey, CapabilitySupport>>
  detect(context: { env: NodeJS.ProcessEnv; cwd: string }): Promise<PlatformDetection>
  render(context: { scope: 'local' | 'global'; targetDir: string; version: string }): Promise<RenderedFile[]>
  receiptRelativePath(scope: 'local' | 'global'): string
  invocation(context: {
    cwd: string
    commandId: string
    argumentsText: string
    interactive: boolean
    env: NodeJS.ProcessEnv
  }): Promise<RuntimeInvocation>
  agentInvocation(context: AgentInvocationContext): Promise<RuntimeInvocation>
}
```

- [ ] **Step 4: Add actionable capability errors**

```ts
export class UnsupportedPlatformCapabilityError extends Error {
  constructor(
    readonly platform: PlatformId,
    readonly capability: CapabilityKey,
    readonly operation: string,
  ) {
    super(`${platform} cannot ${operation}: ${capability} is unsupported`)
  }
}
```

- [ ] **Step 5: Implement the registry with injected adapters**

The default registry may initially use descriptor-only stubs for non-Claude platforms, but every stub must report unavailable rather than simulate execution.

```ts
export class PlatformRegistry {
  register(adapter: PlatformAdapter): void
  get(id: PlatformId): PlatformAdapter
  ids(): PlatformId[]
  detectAll(context: { env: NodeJS.ProcessEnv; cwd: string }): Promise<Record<PlatformId, PlatformDetection>>
}
```

- [ ] **Step 6: Run focused and compatibility tests**

```bash
cd engine
npx vitest run tests/platform/registry.test.ts
npm run test:compat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/platform/ids.ts engine/src/platform/capabilities.ts engine/src/platform/adapter.ts engine/src/platform/errors.ts engine/src/platform/registry.ts engine/tests/platform/registry.test.ts
git commit -m "feat(platform): define host adapter contracts"
```

---

### Task 3: Make Project Resolution and CLI Selection Platform-Neutral

**Files:**
- Create: `engine/src/platform/project-context.ts`
- Modify: `engine/src/mcp/server.ts`
- Modify: `engine/src/cli/index.ts`
- Modify: `engine/src/web/cli.ts`
- Test: `engine/tests/platform/project-context.test.ts`
- Test: `engine/tests/mcp/server.test.ts`
- Test: `engine/tests/cli/index.test.ts`
- Test: `engine/tests/web/cli.test.ts`

**Interfaces:**
- Consumes: `PlatformId`, `PlatformRegistry`.
- Produces: `resolveProjectDir()`, `resolvePlatformSelection()`, CLI `--platform`, and host-neutral `MJLOOP_PROJECT_DIR`.

- [ ] **Step 1: Write precedence tests for project directory resolution**

```ts
import { describe, expect, it } from 'vitest'
import { resolveProjectDir } from '../../src/platform/project-context.js'

describe('project context', () => {
  it('prefers an explicit argument', () => {
    expect(resolveProjectDir('/explicit', { MJLOOP_PROJECT_DIR: '/shared', CLAUDE_PROJECT_DIR: '/claude' }, '/cwd'))
      .toBe('/explicit')
  })

  it('uses MJLOOP_PROJECT_DIR before the legacy Claude variable', () => {
    expect(resolveProjectDir(undefined, { MJLOOP_PROJECT_DIR: '/shared', CLAUDE_PROJECT_DIR: '/claude' }, '/cwd'))
      .toBe('/shared')
  })

  it('keeps CLAUDE_PROJECT_DIR as a compatibility fallback', () => {
    expect(resolveProjectDir(undefined, { CLAUDE_PROJECT_DIR: '/claude' }, '/cwd')).toBe('/claude')
  })
})
```

Expected initial result: FAIL.

- [ ] **Step 2: Implement host-neutral project context**

```ts
export function resolveProjectDir(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return explicit || env.MJLOOP_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || cwd
}
```

Keep `CLAUDE_PROJECT_DIR` documented as a deprecated compatibility input; do not remove it.

- [ ] **Step 3: Add a strict platform selector**

```ts
export function resolvePlatformSelection(
  value: string | undefined,
  fallback: PlatformId = 'claude-code',
): PlatformId
```

Unknown ids must fail with the valid id list. An omitted platform remains `claude-code` until the user selects another host, preserving every existing command.

- [ ] **Step 4: Add `--platform` to CLI and web argument parsing**

Examples:

```bash
mjloop-cli summary --dir . --platform codex
mjloop-web --dir . --platform gemini-cli
```

`summary` remains platform-neutral; the option is accepted so one CLI grammar can be used by the installer, doctor, supervisor, and cockpit.

- [ ] **Step 5: Replace MCP’s direct environment lookup**

`engine/src/mcp/server.ts` imports the shared resolver. Update the MCP argument description to:

```text
Project root. Defaults to MJLOOP_PROJECT_DIR, legacy CLAUDE_PROJECT_DIR, or cwd.
```

- [ ] **Step 6: Run focused and compatibility tests**

```bash
cd engine
npx vitest run tests/platform/project-context.test.ts tests/mcp/server.test.ts tests/cli/index.test.ts tests/web/cli.test.ts
npm run test:compat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/platform/project-context.ts engine/src/mcp/server.ts engine/src/cli/index.ts engine/src/web/cli.ts engine/tests/platform/project-context.test.ts engine/tests/mcp/server.test.ts engine/tests/cli/index.test.ts engine/tests/web/cli.test.ts
git commit -m "refactor(platform): resolve projects independently of Claude"
```

---

### Task 4: Create Canonical Command, Agent, and Skill Definitions

**Files:**
- Create: `definitions/catalog.yaml`
- Create: `definitions/commands/*.md`
- Create: `definitions/agents/*.md`
- Create: `definitions/skills/*/SKILL.md`
- Create: `engine/src/platform/definitions/schema.ts`
- Create: `engine/src/platform/definitions/load.ts`
- Create: `engine/src/platform/definitions/tokens.ts`
- Create: `engine/src/platform/definitions/compile.ts`
- Create: `engine/tests/platform/definitions.test.ts`

**Interfaces:**
- Consumes: existing root `commands/`, `agents/`, and `skills/`.
- Produces: `DefinitionCatalog`, `CanonicalCommand`, `CanonicalAgent`, `CanonicalSkill`, `loadDefinitionCatalog()`, and `compileDefinitions(adapter)`.

- [ ] **Step 1: Define the canonical catalog schema**

Use provider-neutral reasoning and capability names:

```yaml
schema_version: 1
commands:
  - id: build
    description: Build something through as many verified cycles as it takes
    argument_hint: "<what to build | P001-S02 | --next>"
    source: commands/build.md
agents:
  - id: builder
    description: Writes code and tests for one build cycle
    source: agents/builder.md
    reasoning: standard
    capabilities: [read, search, edit, write, shell]
  - id: verifier
    description: Judges work using engine-recorded verification
    source: agents/verifier.md
    reasoning: deep
    capabilities: [read, search, shell, mcp-verify]
skills:
  - id: mjloop-leader
    source: skills/mjloop-leader/SKILL.md
```

Populate all commands, agents, and skills from the feature contract.

Use this exact agent metadata mapping:

| Agent | Reasoning | Canonical capabilities |
|---|---|---|
| `builder` | `standard` | `read, search, edit, write, shell` |
| `critic` | `deep` | `read, search, shell` |
| `docs` | `standard` | `read, search, edit, write` |
| `editor` | `standard` | `read, search, edit, write, shell` |
| `fit-checker` | `deep` | `read, search, shell` |
| `fixer` | `deep` | `read, search, edit, write, shell` |
| `hypothesis-tester` | `standard` | `read, search, shell` |
| `investigator` | `deep` | `read, search, shell` |
| `perf` | `standard` | `read, search, shell` |
| `plan-critic` | `deep` | `read, search, write` |
| `planner` | `deep` | `read, search, write` |
| `reproducer` | `standard` | `read, search, edit, write, shell` |
| `scout` | `standard` | `read, search` |
| `security` | `deep` | `read, search, shell` |
| `story-critic` | `deep` | `read, search` |
| `story-writer` | `deep` | `read, search, mcp-story-add` |
| `ui-critic` | `deep` | `read, search` |
| `ui-designer` | `deep` | `read, search, write` |
| `verifier` | `deep` | `read, search, shell, mcp-verify` |

Every command source is `definitions/commands/<id>.md`; every skill source is `definitions/skills/<id>/SKILL.md`. Descriptions and argument hints are copied exactly from the current frontmatter before host tokens are replaced.

- [ ] **Step 2: Define and test canonical tokens**

Supported tokens are exact and finite:

```ts
export const DefinitionTokenSchema = z.enum([
  'arguments',
  'command:init',
  'command:edit',
  'command:plan',
  'command:build',
  'command:fix',
  'command:status',
  'command:stop',
  'command:resume',
  'command:design-sync',
  'command:web',
  'command:add',
  'skill:mjloop-contract',
  'skill:mjloop-extend',
  'skill:mjloop-leader',
  'skill:mjloop-state',
  'skill:mjloop-tracks',
  'mcp:verify-run',
  'mcp:story-add',
  'platform:project-instructions',
  'platform:extension-agent-dir',
  'platform:extension-skill-dir',
  'platform:root'
])
export type DefinitionToken = z.infer<typeof DefinitionTokenSchema>
```

Canonical Markdown uses `{{arguments}}` and `{{command:build}}`. Compilation fails on an unknown or unresolved token.

- [ ] **Step 3: Write failing definition tests**

```ts
it('contains every feature-contract command, agent, and skill', async () => {
  const contract = await loadFeatureContract()
  const catalog = await loadDefinitionCatalog()
  expect(catalog.commands.map((item) => item.id).sort()).toEqual(contract.commands)
  expect(catalog.agents.map((item) => item.id).sort()).toEqual(contract.agents)
  expect(catalog.skills.map((item) => item.id).sort()).toEqual(contract.skills)
})

it('contains no host-specific text in canonical metadata', async () => {
  const files = await loadCanonicalDefinitionFiles()
  for (const file of files) {
    expect(file.content).not.toMatch(/CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|\.claude\/|model:\s*(opus|sonnet)/)
  }
})

it('refuses unresolved tokens', () => {
  expect(() => compileText('Use {{command:missing}}', fakeAdapterTokens())).toThrow(/unknown definition token/)
})
```

Expected initial result: FAIL.

- [ ] **Step 4: Copy current prose into canonical definitions and replace only host syntax**

Examples:

```text
/mjloop:build $ARGUMENTS
```

becomes:

```text
{{command:build}} {{arguments}}
```

and:

```text
.claude/agents/<name>.md
```

becomes:

```text
{{platform:extension-agent-dir}}/<name>.md
```

Do not simplify, summarize, or rewrite the operational rules while making these substitutions.

- [ ] **Step 5: Implement the loader and compiler**

```ts
export interface CompileTokens {
  readonly values: Readonly<Record<DefinitionToken, string>>
}

export interface CompiledDefinitions {
  commands: ReadonlyMap<string, string>
  agents: ReadonlyMap<string, string>
  skills: ReadonlyMap<string, string>
}

export async function loadDefinitionCatalog(): Promise<DefinitionCatalog>
export async function compileDefinitions(tokens: CompileTokens): Promise<CompiledDefinitions>
```

Validate duplicate ids, missing source files, frontmatter ids that disagree with the catalog, unknown capabilities, and unresolved tokens.

- [ ] **Step 6: Run focused tests**

```bash
cd engine
npx vitest run tests/platform/definitions.test.ts tests/platform/feature-contract.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add definitions engine/src/platform/definitions engine/tests/platform/definitions.test.ts
git commit -m "refactor(platform): add canonical mjloop definitions"
```

---

### Task 5: Extract the Existing Claude Code Integration as the Reference Adapter

**Files:**
- Create: `platforms/claude-code/descriptor.json`
- Create: `engine/src/platform/adapters/claude-code/index.ts`
- Create: `engine/src/platform/adapters/claude-code/detect.ts`
- Create: `engine/src/platform/adapters/claude-code/render.ts`
- Create: `engine/src/platform/adapters/claude-code/runtime.ts`
- Create: `engine/src/platform/adapters/claude-code/hooks.ts`
- Create: `engine/tests/platform/adapters/claude-code.test.ts`
- Modify: `engine/src/platform/registry.ts`
- Modify: `engine/scripts/build.mjs`
- Modify: `engine/package.json`
- Generated but preserved: `commands/**`, `agents/**`, `skills/**`, `hooks/**`, `.claude-plugin/**`

**Interfaces:**
- Consumes: canonical definitions and `PlatformAdapter`.
- Produces: `claudeCodeAdapter`, `renderClaudeDistribution()`, and `npm run platform:check`.

- [ ] **Step 1: Record Claude’s capability descriptor**

```json
{
  "id": "claude-code",
  "display_name": "Claude Code",
  "binary": "claude",
  "capabilities": {
    "project-instructions": "native",
    "commands": "native",
    "skills": "native",
    "subagents": "native",
    "per-agent-model-routing": "native",
    "agent-tool-policy": "native",
    "mcp": "native",
    "session-start-context": "native",
    "protected-write-interception": "native",
    "autonomous-continuation": "native",
    "interactive-pty": "native",
    "headless-execution": "native"
  }
}
```

- [ ] **Step 2: Write a failing semantic-parity test**

The test compiles canonical definitions through the Claude adapter into a temporary directory and compares:

1. command ids, descriptions, argument hints, and prompt bodies;
2. agent ids, descriptions, tool permissions, reasoning tier mapping, and bodies;
3. skill ids, descriptions, and bodies;
4. hook events and scripts;
5. MCP command path and plugin manifest version.

```ts
it('renders the current Claude distribution without semantic drift', async () => {
  const rendered = await renderClaudeDistribution()
  const shipped = await scanClaudeDistributionTree(repositoryRoot)
  expect(normalizeClaudeDistribution(rendered)).toEqual(normalizeClaudeDistribution(shipped))
})
```

Expected initial result: FAIL.

- [ ] **Step 3: Implement Claude token and reasoning mappings**

Required mappings:

```ts
const commandName = (id: string): string => `/mjloop:${id}`
const argumentToken = '$ARGUMENTS'
const reasoningModel = {
  standard: 'sonnet',
  deep: 'opus',
} as const
```

MCP-qualified tool names remain exactly those currently accepted by Claude plugin agents.

- [ ] **Step 4: Implement Claude rendering**

Render:

- root `commands/*.md`;
- root `agents/*.md`;
- root `skills/*/SKILL.md`;
- `hooks/hooks.json` and scripts;
- `.claude-plugin/plugin.json`;
- `.claude-plugin/marketplace.json`.

Add a generated header only where the host format allows comments without changing semantics. Where comments are not allowed, rely on the install receipt and `platform:check`.

- [ ] **Step 5: Implement Claude detection and invocation**

Interactive:

```ts
{
  binary: process.env.MJLOOP_CLAUDE_BIN || 'claude',
  args: ['/mjloop:build requested work'],
  cwd,
  env: { ...env, MJLOOP_PROJECT_DIR: cwd }
}
```

Headless smoke:

```text
claude -p "/mjloop:status"
```

Keep `MJLOOP_WEB_CLAUDE_BIN` as a deprecated alias for one release and prefer `MJLOOP_CLAUDE_BIN`.

- [ ] **Step 6: Add generation and check scripts**

```json
{
  "scripts": {
    "platform:generate": "node dist/cli/index.js platform generate",
    "platform:check": "node dist/cli/index.js platform check",
    "test:claude-parity": "vitest run tests/platform/adapters/claude-code.test.ts tests/platform/feature-contract.test.ts"
  }
}
```

`platform:check` must diff generated content in memory and never rewrite the tree.

- [ ] **Step 7: Pass the Claude compatibility gate**

```bash
cd engine
npm run test:claude-parity
npm run test:compat
npm test
npm run typecheck
npm run build
npm run verify:ship
cd ..
LOOP_E2E=1 bash tests/e2e/run-edit.sh
LOOP_E2E=1 bash tests/e2e/run-build.sh
LOOP_E2E=1 bash tests/e2e/run-fix.sh
LOOP_E2E=1 bash tests/e2e/run-plan.sh
LOOP_E2E=1 bash tests/e2e/run-story.sh
LOOP_E2E=1 bash tests/e2e/run-design-sync.sh
LOOP_E2E=1 bash tests/e2e/run-add.sh
```

Expected: every existing test and Claude smoke test passes before Task 6 starts.

- [ ] **Step 8: Commit**

```bash
git add platforms/claude-code engine/src/platform/adapters/claude-code engine/src/platform/registry.ts engine/tests/platform/adapters/claude-code.test.ts engine/scripts/build.mjs engine/package.json commands agents skills hooks .claude-plugin
git commit -m "refactor(platform): preserve Claude behind its adapter"
```

---

### Task 6: Add Host-Neutral Sessions, Isolated Agent Dispatch, Continuation, and Tamper Detection

**Files:**
- Create: `engine/src/platform/runtime/invocation.ts`
- Create: `engine/src/platform/runtime/session.ts`
- Create: `engine/src/platform/runtime/agent-dispatch.ts`
- Create: `engine/src/platform/runtime/supervisor.ts`
- Create: `engine/src/platform/runtime/tamper.ts`
- Create: `engine/tests/platform/agent-dispatch.test.ts`
- Create: `engine/tests/platform/supervisor.test.ts`
- Create: `engine/tests/platform/tamper.test.ts`
- Modify: `engine/src/mcp/server.ts`
- Modify: `engine/src/web/session.ts`
- Modify: `engine/src/web/queue.ts`
- Modify: `engine/src/web/completion.ts`
- Test: `engine/tests/web/queue.test.ts`
- Test: `engine/tests/web/completion.test.ts`
- Test: `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `RuntimeInvocation`, canonical agents, platform capabilities, state summaries, run paths, the active roster, and existing `LoopSession`.
- Produces: `spawnPlatformSession()`, `AgentDispatcher`, `ContinuationSupervisor`, `TamperGuard`, a fallback `mjloop_agent_dispatch` MCP tool, and platform-tagged queue jobs.

- [ ] **Step 1: Generalize the session factory without changing queue semantics**

Rename the conceptual comment and types, not the public behavior:

```ts
export interface PlatformSession {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(fn: (chunk: string) => void): void
  onExit(fn: (code: number) => void): void
}

export type PlatformSessionFactory = (invocation: RuntimeInvocation & {
  cols: number
  rows: number
}) => PlatformSession
```

Keep a compatibility type alias for `LoopSession` for one release so unrelated tests do not require a big-bang edit.

- [ ] **Step 2: Write a failing platform-tagged queue test**

```ts
it('launches each job through its selected adapter', () => {
  const spawned: string[] = []
  const queue = createQueue({
    spawnForPlatform: (platform) => {
      spawned.push(platform)
      return fakeSession()
    },
  })
  queue.enqueue({ platform: 'codex', commandId: 'build', argumentsText: 'add search' })
  expect(spawned).toEqual(['codex'])
})
```

Existing string-only `enqueue(command)` remains accepted and maps to `claude-code` during the compatibility window.

- [ ] **Step 3: Write failing isolated-agent-dispatch tests**

```ts
it('dispatches a selected agent in a clean child context', async () => {
  const dispatcher = createAgentDispatcher({
    adapter: fakeAdapterReturning(validBuilderResult),
    loadRoster: async () => ({ selected: ['builder'], skipped: {} }),
  })
  const result = await dispatcher.dispatch({
    projectDir,
    platform: 'codex',
    agentId: 'builder',
    instance: null,
    brief: validBrief,
  })
  expect(result.status).toBe('pass')
})

it('refuses an agent outside the active roster', async () => {
  const dispatcher = createAgentDispatcher({
    adapter: fakeAdapterReturning(validBuilderResult),
    loadRoster: async () => ({ selected: ['verifier'], skipped: {} }),
  })
  await expect(dispatcher.dispatch({
    projectDir,
    platform: 'codex',
    agentId: 'builder',
    instance: null,
    brief: validBrief,
  })).rejects.toThrow(/builder is not selected in the active roster/)
})
```

Also cover timeout termination, cancellation, the configured parallel cap, one corrective retry for malformed contract output, a second malformed result becoming a cycle failure, and unique `instance` values for parallel copies of one agent.

- [ ] **Step 4: Implement the fallback agent dispatcher**

```ts
export interface AgentDispatchRequest {
  projectDir: string
  platform: PlatformId
  agentId: string
  instance: string | null
  brief: string
}

export class AgentDispatcher {
  dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentResult>
}
```

Rules:

1. load the active run and cycle roster;
2. refuse an unselected agent or an agent absent from the canonical catalog;
3. compile that agent for the selected platform;
4. map canonical reasoning and capabilities into an adapter-owned execution policy;
5. refuse dispatch when the adapter cannot enforce the agent’s required write/shell/MCP boundary;
6. launch `adapter.agentInvocation()` in a fresh headless child context;
7. pass an explicit JSON result schema path;
8. validate output with `AgentResultSchema`;
9. retry once with a corrective contract prompt on malformed output;
10. kill on timeout/cancellation and return a bounded error;
11. never allow the leader agent itself to recurse through the fallback dispatcher;
12. leave result persistence to the leader’s existing `mjloop_run_log` call.

Platforms with native isolated subagents keep using their native tool. Platforms whose capability probe reports `subagents: emulated` use this dispatcher, preserving context isolation instead of asking the main agent to impersonate every specialist.

- [ ] **Step 5: Register the fallback MCP tool**

Add `mjloop_agent_dispatch` with:

```ts
{
  project_dir: projectDirArg,
  platform: PlatformIdSchema,
  agent: AgentNameSchema,
  instance: z.string().min(1).optional(),
  brief: z.string().min(1),
  timeout_ms: z.number().int().positive().optional()
}
```

The feature contract treats 18 as the minimum baseline tool count, so adding this tool does not weaken or invalidate the original MCP surface.

- [ ] **Step 6: Define bounded continuation**

```ts
export interface ContinuationPolicy {
  maxSessionRestartsPerCycle: number
  noStateChangeRestarts: number
}

export interface ContinuationDecision {
  action: 'resume' | 'complete' | 'halt' | 'wait'
  reason: string
}
```

Defaults:

```ts
{
  maxSessionRestartsPerCycle: 2,
  noStateChangeRestarts: 1
}
```

The supervisor:

1. reads state before launch;
2. starts the adapter’s headless `resume` invocation;
3. reads state after exit;
4. resumes only when status is still `running`, `autonomous` is true, and state progressed;
5. halts with `runtime-restart-cap` when restart bounds are exhausted;
6. never starts two sessions for one project.

- [ ] **Step 7: Write supervisor tests**

Cover:

- terminal `done` does not restart;
- terminal `halted` does not restart;
- `autonomous: false` does not restart;
- one progressing open run restarts;
- no state change reaches a bounded halt;
- a recovered backup summary never triggers unattended continuation;
- a missing track cap never triggers unattended continuation;
- native Claude Stop-hook mode does not also start the supervisor.

- [ ] **Step 8: Add tamper detection for platforms without write interception**

```ts
export interface ProtectedSnapshot {
  stateDigest: string
  manifestDigests: Record<string, string>
  verifyPinDigest: string | null
}

export class TamperGuard {
  capture(projectDir: string): Promise<ProtectedSnapshot>
  compare(projectDir: string, expected: ProtectedSnapshot): Promise<{
    clean: boolean
    changed: string[]
  }>
}
```

Capture immediately before a host session. After it exits, compare protected files against engine-recorded write receipts. An unexplained change halts the run with `protected-state-tamper` and names the files. Do not silently restore or accept the changed state.

- [ ] **Step 9: Run runtime, dispatcher, MCP, and queue tests**

```bash
cd engine
npx vitest run tests/platform/agent-dispatch.test.ts tests/platform/supervisor.test.ts tests/platform/tamper.test.ts tests/mcp/server.test.ts tests/web/queue.test.ts tests/web/completion.test.ts
npm run test:compat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add engine/src/platform/runtime engine/src/mcp/server.ts engine/src/web/session.ts engine/src/web/queue.ts engine/src/web/completion.ts engine/tests/platform/agent-dispatch.test.ts engine/tests/platform/supervisor.test.ts engine/tests/platform/tamper.test.ts engine/tests/mcp/server.test.ts engine/tests/web/queue.test.ts engine/tests/web/completion.test.ts
git commit -m "feat(platform): add bounded isolated host sessions"
```

---

### Task 7: Build a Transactional Universal Installer and Doctor

**Files:**
- Create: `engine/src/platform/install/schema.ts`
- Create: `engine/src/platform/install/paths.ts`
- Create: `engine/src/platform/install/merge.ts`
- Create: `engine/src/platform/install/plan.ts`
- Create: `engine/src/platform/install/apply.ts`
- Create: `engine/src/platform/install/receipt.ts`
- Create: `engine/tests/platform/install.test.ts`
- Modify: `engine/src/cli/index.ts`
- Modify: `engine/package.json`

**Interfaces:**
- Consumes: platform registry and adapter renderers.
- Produces: `createInstallPlan()`, `applyInstallPlan()`, `uninstallManagedFiles()`, `doctorPlatforms()`, and the `mjloop platform` subcommands listed in Step 5.

- [ ] **Step 1: Define install and receipt schemas**

```ts
export interface InstallRequest {
  platforms: PlatformId[]
  scope: 'local' | 'global'
  targetDir: string
  dryRun: boolean
}

export interface ManagedFileReceipt {
  path: string
  sha256: string
  mode: number
  ownership: 'managed' | 'merged'
}

export interface InstallationReceipt {
  schemaVersion: 1
  mjloopVersion: string
  platform: PlatformId
  scope: 'local' | 'global'
  installedAt: string
  files: ManagedFileReceipt[]
}
```

Store each receipt inside that adapter’s managed installation root, for example beside its generated skills, extension, or plugin files. Do not place installation receipts under `.mjloop/`, because installing host integration must not make an uninitialized project look initialized. Store global receipts under the platform’s global mjloop installation root, never in an unrelated user config root.

- [ ] **Step 2: Write failing transaction tests**

Cover:

- dry-run performs no writes;
- path traversal such as `../../file` is rejected;
- a staged write failure leaves the destination unchanged;
- an existing identical managed file is reused;
- an existing different user file creates a conflict;
- structured config merge preserves unrelated keys;
- uninstall removes only unchanged managed files;
- uninstall preserves modified managed files and reports them;
- uninstall never removes `.mjloop/state.json`, plans, runs, or memory;
- pre-existing directory permissions remain unchanged.

- [ ] **Step 3: Implement staged apply**

Algorithm:

1. validate every path remains under the selected installation root;
2. render into `mkdtemp()` staging;
3. calculate SHA-256 and modes;
4. compare with destination and receipt;
5. reject unresolved conflicts before the first destination write;
6. rename managed files atomically where possible;
7. structurally merge supported JSON/TOML files through adapter-owned merge functions;
8. write the receipt last;
9. on error, restore only files changed by the current transaction.

- [ ] **Step 4: Implement instruction-block merge**

Markdown instruction files use exact markers:

```markdown
<!-- mjloop:start -->
## mjloop

This project uses mjloop. Execution state lives in `.mjloop/`.
<!-- mjloop:end -->
```

Rules:

- replace only the marked block;
- preserve the rest byte-for-byte;
- reject nested or duplicate marker pairs;
- never create a symlink;
- never follow a destination symlink outside the install root.

- [ ] **Step 5: Add CLI commands**

```text
mjloop platform list
mjloop platform detect
mjloop platform install --platform claude-code --scope local --dir .
mjloop platform install --platform codex --platform gemini-cli --scope local --dir .
mjloop platform install --all --scope global
mjloop platform uninstall --platform opencode --scope local --dir .
mjloop platform doctor --dir .
```

`doctor` reports host binary/version, installed files, MCP reachability, command/skill discovery, lifecycle strategy, conflicts, and unsupported capabilities. It never changes state.

- [ ] **Step 6: Add the public binary without removing existing bins**

Keep:

- `mjloop-mcp`
- `mjloop-cli`
- `mjloop-web`

Add:

```json
{
  "bin": {
    "mjloop": "./dist/cli/index.js"
  }
}
```

- [ ] **Step 7: Run installer tests and compatibility gate**

```bash
cd engine
npx vitest run tests/platform/install.test.ts tests/cli/index.test.ts
npm run test:compat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add engine/src/platform/install engine/tests/platform/install.test.ts engine/src/cli/index.ts engine/package.json
git commit -m "feat(platform): add transactional multi-host installer"
```

---

### Task 8: Implement the Codex Adapter

**Files:**
- Create: `platforms/codex/descriptor.json`
- Create: `engine/src/platform/adapters/codex/index.ts`
- Create: `engine/src/platform/adapters/codex/detect.ts`
- Create: `engine/src/platform/adapters/codex/render.ts`
- Create: `engine/src/platform/adapters/codex/runtime.ts`
- Create: `engine/src/platform/adapters/codex/merge.ts`
- Create: `engine/tests/platform/adapters/codex.test.ts`
- Create: `tests/e2e/platform-codex.sh`
- Modify: `engine/src/platform/registry.ts`

**Interfaces:**
- Consumes: canonical definitions, installer, supervisor, tamper guard.
- Produces: `codexAdapter`.

- [ ] **Step 1: Lock the supported Codex surface against current official docs**

Before code, verify the installed/target Codex version and record in the adapter test fixture:

- project instructions: `AGENTS.md`;
- Agent Skills: `.agents/skills/<skill>/SKILL.md`;
- project MCP configuration supported by that Codex version;
- interactive command: `codex`;
- headless command: `codex exec`;
- resume syntax supported by that version.

If official behavior differs from these paths, update only `platforms/codex/descriptor.json` and Codex adapter tests; do not change canonical definitions.

- [ ] **Step 2: Write failing Codex renderer tests**

```ts
it('renders every mjloop command as an invocable Codex skill', async () => {
  const files = await codexAdapter.render(localContext)
  for (const command of featureContract.commands) {
    expect(files.some((file) => file.relativePath === `.agents/skills/mjloop-${command}/SKILL.md`)).toBe(true)
  }
})

it('merges an mjloop block into AGENTS.md', async () => {
  const merged = mergeCodexInstructions('# Existing rules\n')
  expect(merged).toContain('# Existing rules')
  expect(merged).toContain('<!-- mjloop:start -->')
})
```

- [ ] **Step 3: Render Codex skills and instructions**

Required command spelling:

```text
$mjloop-init
$mjloop-edit
$mjloop-plan
$mjloop-build
$mjloop-fix
$mjloop-status
$mjloop-stop
$mjloop-resume
$mjloop-design-sync
$mjloop-web
$mjloop-add
$mjloop-release
```

Each generated skill contains the canonical command body with Codex-specific explicit invocation, project instruction, MCP tool, and agent-dispatch syntax.

- [ ] **Step 4: Configure MCP without replacing user configuration**

Use the supported Codex project-scoped MCP representation. Merge only the `mjloop` server entry. Refuse when an existing `mjloop` entry points somewhere else unless the user passes an explicit replacement flag.

The server launch must set:

```text
MJLOOP_PROJECT_DIR=<project>
```

- [ ] **Step 5: Implement runtime invocation and capability probe**

Interactive invocation opens Codex with the generated skill invocation as the initial request. Headless invocation uses `codex exec` and requests structured output when supported. Detection records version and probes skill/MCP discovery using read-only commands.

Subagent support is version-probed. If unavailable, the generated leader uses `mjloop_agent_dispatch`, which starts each selected agent in a clean Codex child context and records `subagents: emulated`. The dispatcher may serialize calls when the host cannot safely run them in parallel, but it must not skip agents or collapse their contexts into the leader.

- [ ] **Step 6: Use the process supervisor and tamper guard**

Codex autonomous mode uses `ContinuationSupervisor`. Every headless session is surrounded by `TamperGuard.capture()` and `compare()`. A tamper result halts rather than continuing.

- [ ] **Step 7: Add staged and real smoke tests**

Staged test:

1. install Codex into a temporary project;
2. assert `AGENTS.md`, all skills, MCP config, and receipt;
3. reinstall and assert idempotence;
4. modify one generated file and assert upgrade refusal;
5. uninstall and assert user content remains.

Real smoke script:

```bash
MJLOOP_E2E_CODEX=1 bash tests/e2e/platform-codex.sh
```

The smoke project runs init, a one-file edit, engine verification, status, and clean stop/resume behavior.

- [ ] **Step 8: Run the Codex phase gate**

```bash
cd engine
npx vitest run tests/platform/adapters/codex.test.ts tests/platform/install.test.ts tests/platform/supervisor.test.ts tests/platform/tamper.test.ts
npm run test:compat
npm test
npm run typecheck
cd ..
MJLOOP_E2E_CODEX=1 bash tests/e2e/platform-codex.sh
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add platforms/codex engine/src/platform/adapters/codex engine/src/platform/registry.ts engine/tests/platform/adapters/codex.test.ts tests/e2e/platform-codex.sh
git commit -m "feat(platform): run mjloop on Codex"
```

---

### Task 9: Implement the Gemini CLI Adapter

**Files:**
- Create: `platforms/gemini-cli/descriptor.json`
- Create: `engine/src/platform/adapters/gemini-cli/index.ts`
- Create: `engine/src/platform/adapters/gemini-cli/detect.ts`
- Create: `engine/src/platform/adapters/gemini-cli/render.ts`
- Create: `engine/src/platform/adapters/gemini-cli/runtime.ts`
- Create: `engine/src/platform/adapters/gemini-cli/hooks.ts`
- Create: `engine/tests/platform/adapters/gemini-cli.test.ts`
- Create: `tests/e2e/platform-gemini.sh`
- Modify: `engine/src/platform/registry.ts`

**Interfaces:**
- Consumes: canonical definitions, installer, supervisor fallback, and Claude hook semantics.
- Produces: `geminiCliAdapter`.

- [ ] **Step 1: Lock the Gemini extension surface**

Target the official extension layout:

- `gemini-extension.json`;
- extension `GEMINI.md` through `contextFileName`;
- extension MCP server using `${extensionPath}`;
- extension commands;
- `SessionStart` for compact state context;
- `BeforeTool` for protected-write interception;
- a continuation hook only when its semantics pass the same bounded-continuation tests.

Record the minimum tested Gemini CLI version in `descriptor.json`.

- [ ] **Step 2: Write failing extension-render tests**

```ts
it('renders a valid Gemini extension manifest', async () => {
  const files = await geminiCliAdapter.render(localContext)
  const manifest = parseRenderedJson(files, 'gemini-extension.json')
  expect(manifest.name).toBe('mjloop')
  expect(manifest.contextFileName).toBe('GEMINI.md')
  expect(manifest.mcpServers.mjloop.command).toBe('node')
})

it('maps the protected state guard to BeforeTool', async () => {
  const hooks = readRenderedGeminiHooks(await geminiCliAdapter.render(localContext))
  expect(hooks.BeforeTool).toBeDefined()
})
```

- [ ] **Step 3: Render extension commands and canonical definitions**

Render all 12 commands with Gemini’s namespaced extension syntax: `/mjloop:init`, `/mjloop:edit`, `/mjloop:plan`, `/mjloop:build`, `/mjloop:fix`, `/mjloop:status`, `/mjloop:stop`, `/mjloop:resume`, `/mjloop:design-sync`, `/mjloop:web`, `/mjloop:add`, and `/mjloop:release`. The command body must call the same leader/state/track concepts and logical MCP tools as Claude.

Do not copy Claude `tools:` or `model:` frontmatter into Gemini files. Map canonical capabilities and reasoning tiers through Gemini’s supported configuration.

If the capability probe cannot dispatch an isolated Gemini subagent, render the leader to call `mjloop_agent_dispatch`; do not execute specialist prompts inside the leader context.

- [ ] **Step 4: Implement hook payload translators**

Create pure translators:

```ts
export function geminiSessionStartPayload(summary: StateSummary): GeminiHookResult
export function geminiProtectedWriteVerdict(input: GeminiBeforeToolInput): GuardVerdict
export function geminiContinuationDecision(input: GeminiAfterAgentInput, summary: StateSummary): ContinuationDecision
```

Reuse `evaluateStateGuard()` and the shared continuation rules; only payload shapes are adapter-specific.

- [ ] **Step 5: Implement runtime invocation and fallback**

Detection verifies `gemini --version` and extension discovery. Interactive mode launches `gemini` with the initial mjloop command. Headless mode uses the documented non-interactive invocation and structured output option.

If the installed version lacks the tested continuation hook behavior, mark autonomous continuation `emulated` and use `ContinuationSupervisor`.

- [ ] **Step 6: Add staged and real smoke tests**

```bash
MJLOOP_E2E_GEMINI=1 bash tests/e2e/platform-gemini.sh
```

The smoke test proves init, edit, verification, protected-state denial/tamper halt, status, and bounded autonomous continuation.

- [ ] **Step 7: Run the Gemini phase gate**

```bash
cd engine
npx vitest run tests/platform/adapters/gemini-cli.test.ts tests/platform/install.test.ts tests/platform/supervisor.test.ts
npm run test:compat
npm test
npm run typecheck
cd ..
MJLOOP_E2E_GEMINI=1 bash tests/e2e/platform-gemini.sh
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add platforms/gemini-cli engine/src/platform/adapters/gemini-cli engine/src/platform/registry.ts engine/tests/platform/adapters/gemini-cli.test.ts tests/e2e/platform-gemini.sh
git commit -m "feat(platform): run mjloop on Gemini CLI"
```

---

### Task 10: Implement the OpenCode Adapter

**Files:**
- Create: `platforms/opencode/descriptor.json`
- Create: `engine/src/platform/adapters/opencode/index.ts`
- Create: `engine/src/platform/adapters/opencode/detect.ts`
- Create: `engine/src/platform/adapters/opencode/render.ts`
- Create: `engine/src/platform/adapters/opencode/runtime.ts`
- Create: `engine/src/platform/adapters/opencode/plugin.ts`
- Create: `engine/src/platform/adapters/opencode/merge.ts`
- Create: `engine/tests/platform/adapters/opencode.test.ts`
- Create: `tests/e2e/platform-opencode.sh`
- Modify: `engine/src/platform/registry.ts`

**Interfaces:**
- Consumes: canonical definitions, structured config merge, supervisor, and tamper guard.
- Produces: `openCodeAdapter`.

- [ ] **Step 1: Lock the OpenCode surface**

Target:

- project `opencode.json` or `opencode.jsonc` structural merge;
- `instructions` entry for mjloop context;
- command entries or generated command files;
- subagent entries;
- skill path registration;
- local MCP server entry;
- local plugin for `tool.execute.before` protected-write checks;
- `opencode run` for headless execution and `--continue`/session support when available.

- [ ] **Step 2: Write failing structured-merge tests**

```ts
it('preserves unrelated OpenCode configuration', () => {
  const existing = {
    model: 'user/provider-model',
    permission: { bash: 'ask' },
    command: { userCommand: { template: 'keep me' } },
  }
  const merged = mergeOpenCodeConfig(existing, mjloopOpenCodeFragment())
  expect(merged.model).toBe('user/provider-model')
  expect(merged.permission).toEqual({ bash: 'ask' })
  expect(merged.command.userCommand.template).toBe('keep me')
  expect(merged.mcp.mjloop).toBeDefined()
})
```

Also test collision refusal for existing `mjloop-*` commands, agents, skills, plugin entries, and MCP names with different content.

- [ ] **Step 3: Render commands, agents, skills, MCP, and plugin**

Render all 12 logical commands as `/mjloop-<id>` OpenCode commands, including `/mjloop-release`.

Map canonical agent capabilities into OpenCode permissions:

- read-only agents deny edits;
- writer agents permit edits;
- security agent keeps network-denial instructions;
- verifier gets the logical verification MCP tool;
- reasoning tiers map through optional adapter configuration without changing the user’s default model.

When native subagents are unavailable or disabled, generated leader instructions use `mjloop_agent_dispatch` so every selected agent still receives an isolated context.

- [ ] **Step 4: Implement protected-write interception**

The generated local plugin handles `tool.execute.before`, extracts target paths for edit/write tools, calls the shared guard evaluator, and denies protected basenames under `.mjloop/`.

Shell commands remain covered by post-session tamper detection because tool-level path extraction cannot prove every shell side effect.

- [ ] **Step 5: Implement runtime invocation**

Interactive mode launches `opencode`. Headless mode uses:

```text
opencode run --format json "<compiled mjloop request>"
```

Use documented continue/session flags only after version detection confirms them.

- [ ] **Step 6: Add staged and real smoke tests**

```bash
MJLOOP_E2E_OPENCODE=1 bash tests/e2e/platform-opencode.sh
```

Prove install merge, init, one edit cycle, subagent dispatch or sequential emulation, engine verification, state protection, status, and uninstall preservation.

- [ ] **Step 7: Run the OpenCode phase gate**

```bash
cd engine
npx vitest run tests/platform/adapters/opencode.test.ts tests/platform/install.test.ts tests/platform/supervisor.test.ts tests/platform/tamper.test.ts
npm run test:compat
npm test
npm run typecheck
cd ..
MJLOOP_E2E_OPENCODE=1 bash tests/e2e/platform-opencode.sh
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add platforms/opencode engine/src/platform/adapters/opencode engine/src/platform/registry.ts engine/tests/platform/adapters/opencode.test.ts tests/e2e/platform-opencode.sh
git commit -m "feat(platform): run mjloop on OpenCode"
```

---

### Task 11: Make Init and Project Extensions Cross-Platform

**Files:**
- Create: `engine/src/platform/extensions/schema.ts`
- Create: `engine/src/platform/extensions/store.ts`
- Create: `engine/src/platform/extensions/render.ts`
- Create: `engine/tests/platform/extensions.test.ts`
- Modify: `engine/src/ops/init.ts`
- Modify: `commands/init.md` through canonical generation
- Modify: `commands/add.md` through canonical generation
- Modify: `skills/mjloop-extend/SKILL.md` through canonical generation
- Modify: `engine/tests/ops/init.test.ts`
- Modify: `tests/e2e/run-add.sh`

**Interfaces:**
- Consumes: platform install receipts and canonical definition compiler.
- Produces: `.mjloop/extensions`, `addExtension()`, `renderProjectExtensions()`, and legacy Claude extension compatibility.

- [ ] **Step 1: Define canonical project extension records**

```ts
export interface ProjectAgentExtension {
  schemaVersion: 1
  kind: 'agent'
  id: string
  description: string
  reasoning: 'standard' | 'deep'
  capabilities: string[]
  body: string
}

export interface ProjectSkillExtension {
  schemaVersion: 1
  kind: 'skill'
  id: string
  description: string
  body: string
}
```

Store:

```text
.mjloop/extensions/agents/<id>.md
.mjloop/extensions/skills/<id>/SKILL.md
```

Tracks remain in `.mjloop/config.yaml`.

- [ ] **Step 2: Write failing extension tests**

Cover:

- one canonical agent renders to every installed platform;
- one canonical skill renders to every installed platform;
- a shipped id collision is refused;
- a project extension collision is refused;
- rendering is transactional across all selected platforms;
- legacy `.claude/agents` files keep working;
- no existing `.claude/agents` file is automatically moved or deleted;
- a dry-run legacy import reports only files matching the mjloop contract.

- [ ] **Step 3: Split engine init from host instruction installation**

Refactor:

```ts
export async function initLoopState(projectDir: string, now?: Clock): Promise<InitResult>
export async function installProjectInstructions(
  projectDir: string,
  platforms: PlatformId[],
): Promise<InstructionInstallResult[]>
```

`mjloop_init` always provisions engine state. The host command or universal CLI passes the active/selected platform list for instruction rendering.

Keep `ensureClaudeMdSection()` as a compatibility wrapper that calls the Claude instruction merger.

- [ ] **Step 4: Update `add` behavior**

New behavior:

1. validate kind and id;
2. refuse shipped-name shadowing;
3. write one canonical extension;
4. read adapter-owned installed-platform receipts;
5. render to each installed platform transactionally;
6. report canonical and generated paths.

If no platform receipt exists, render only to the active platform and create its receipt.

- [ ] **Step 5: Add an explicit legacy import command**

```text
mjloop platform migrate-extensions --from claude-code --dry-run
mjloop platform migrate-extensions --from claude-code --apply
```

Import only files that contain the full mjloop result-contract markers. Never infer that every user file under `.claude/agents` belongs to mjloop.

- [ ] **Step 6: Run extension, init, and Claude compatibility tests**

```bash
cd engine
npx vitest run tests/platform/extensions.test.ts tests/ops/init.test.ts tests/platform/adapters/claude-code.test.ts
npm run test:compat
npm run typecheck
cd ..
LOOP_E2E=1 bash tests/e2e/run-add.sh
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/platform/extensions engine/tests/platform/extensions.test.ts engine/src/ops/init.ts engine/tests/ops/init.test.ts definitions/commands/init.md definitions/commands/add.md definitions/skills/mjloop-extend/SKILL.md commands/init.md commands/add.md skills/mjloop-extend/SKILL.md tests/e2e/run-add.sh
git commit -m "feat(platform): render project extensions for every host"
```

---

### Task 12: Add Platform Selection and Diagnostics to the Cockpit

**Files:**
- Modify: `engine/src/web/protocol.ts`
- Modify: `engine/src/web/queue.ts`
- Modify: `engine/src/web/server.ts`
- Modify: `engine/src/web/snapshot.ts`
- Modify: `engine/src/web/read.ts`
- Modify: `engine/src/web/public/panels/launcher.js`
- Modify: `engine/src/web/public/panels/config.js`
- Modify: `engine/src/web/public/locales/en.json`
- Modify: `engine/src/web/public/locales/ar.json`
- Modify: `engine/tests/web/queue.test.ts`
- Modify: `engine/tests/web/server.test.ts`
- Modify: `engine/tests/web/snapshot.test.ts`
- Modify: `engine/tests/web/panels.test.ts`
- Modify: `engine/tests/web/locales.test.ts`

**Interfaces:**
- Consumes: registry detection, platform runtime sessions, install doctor.
- Produces: platform-tagged `Job`, `PlatformView`, launcher selector, and capability diagnostics.

- [ ] **Step 1: Extend protocol types with backward-compatible defaults**

```ts
export const PlatformViewSchema = z.object({
  id: PlatformIdSchema,
  displayName: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  capabilities: z.record(CapabilityKeySchema, CapabilitySupportSchema),
  problems: z.array(z.string()),
})

export const JobSchema = z.object({
  id: z.string(),
  platform: PlatformIdSchema.default('claude-code'),
  commandId: z.string(),
  argumentsText: z.string(),
  status: JobStatusSchema,
  reason: MessageSchema.nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
})
```

The default keeps old snapshots and tests readable.

- [ ] **Step 2: Write failing launcher and queue tests**

Cover:

- platform selector lists only detected/installed adapters by default;
- unavailable adapters appear in diagnostics but cannot enqueue;
- a job snapshot records platform;
- sequential queue remains per project across different platforms;
- resume uses the same platform as the interrupted job;
- legacy string enqueue remains Claude;
- localized labels exist in English and Arabic.

- [ ] **Step 3: Inject the registry into the server**

```ts
export interface ServerOptions {
  projectDir: string
  port: number
  platformRegistry?: PlatformRegistry
  spawn?: PlatformSessionFactory
  pollMs?: number
}
```

Tests inject fake adapters. Production uses `createPlatformRegistry()`.

- [ ] **Step 4: Update the launcher**

The launcher provides:

- platform selector;
- logical command selector;
- argument field;
- auto/supervised indicator;
- capability warning;
- install/doctor command copy when the platform is unavailable.

Never ask the user to type host-specific command syntax manually; the adapter compiles it.

- [ ] **Step 5: Preserve cockpit safety properties**

Tests must continue proving:

- server binds `127.0.0.1`, never `0.0.0.0`;
- token comparison remains constant-time;
- query token becomes an HttpOnly, SameSite=Strict cookie;
- no unauthenticated API, asset, or WebSocket access;
- queue is sequential;
- transcripts are bounded;
- shutdown kills the active session and closes sockets;
- all test-created runtimes close even after failure.

- [ ] **Step 6: Run cockpit and compatibility tests**

```bash
cd engine
npx vitest run tests/web
npm run test:compat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/web engine/tests/web
git commit -m "feat(web): select and diagnose AI platforms"
```

---

### Task 13: Generalize Build, Shipment Verification, and Release

**Files:**
- Create: `engine/scripts/generate-platforms.mjs`
- Create: `engine/scripts/verify-platform-packages.mjs`
- Modify: `engine/scripts/build.mjs`
- Modify: `engine/scripts/verify-ship.mjs`
- Modify: `engine/package.json`
- Modify: `commands/release.md` through canonical generation
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Test: `engine/tests/integration/platform-packages.test.ts`

**Interfaces:**
- Consumes: all renderers, installer, existing bundle builder, current release checks.
- Produces: reproducible platform packages, `verify:platforms`, and synchronized release versions.

- [ ] **Step 1: Write a failing package-matrix test**

```ts
it('builds a complete package for every platform', async () => {
  const matrix = await inspectBuiltPlatforms()
  expect(matrix.map((item) => item.id)).toEqual([
    'claude-code',
    'codex',
    'gemini-cli',
    'opencode',
  ])
  for (const item of matrix) {
    expect(item.mcpStarts).toBe(true)
    expect(item.commandsComplete).toBe(true)
    expect(item.skillsComplete).toBe(true)
  }
})
```

- [ ] **Step 2: Generate platform artifacts reproducibly**

`generate-platforms.mjs`:

1. loads canonical definitions;
2. renders each adapter to a clean temporary directory;
3. validates against the feature contract;
4. writes `dist/platforms/<id>/`;
5. normalizes ordering and line endings;
6. emits no timestamps inside generated content;
7. refuses unresolved tokens.

- [ ] **Step 3: Expand staged shipment verification**

For each platform, copy only the files that would be distributed into an empty staging directory with no `node_modules`, then prove:

- MCP handshake lists all tools;
- CLI help and doctor run;
- rendered definitions match the feature contract;
- manifests/config parse;
- static imports and assets resolve;
- no source-only path appears;
- optional PTY remains isolated to cockpit use;
- install/uninstall transaction works in a temporary project;
- platform package contains no undeclared extra file.

- [ ] **Step 4: Synchronize versions**

One release version must match:

- `.claude-plugin/plugin.json`;
- `.claude-plugin/marketplace.json` when it carries a version;
- `engine/package.json`;
- every generated platform descriptor/manifest;
- installation receipts created from that release.

Add a check that fails before any tag when versions differ.

- [ ] **Step 5: Generalize release language without breaking Claude marketplace release**

The release command still updates/publishes the Claude marketplace package, and additionally:

- generates all platform packages;
- runs all staged verifiers;
- publishes the universal npm package when configured;
- emits release notes with per-platform support status;
- refuses release if any target adapter is red;
- never publishes from a dirty tree.

- [ ] **Step 6: Add scripts**

```json
{
  "scripts": {
    "generate:platforms": "node scripts/generate-platforms.mjs",
    "verify:platforms": "node scripts/verify-platform-packages.mjs",
    "verify:ship": "node scripts/verify-ship.mjs && npm run verify:platforms"
  }
}
```

- [ ] **Step 7: Run build and shipment gates**

```bash
cd engine
npm run generate:platforms
npm run build
npm run verify:ship
npx vitest run tests/integration/platform-packages.test.ts
npm run test:compat
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit generated bundles with source changes**

```bash
git add engine/scripts engine/package.json engine/tests/integration/platform-packages.test.ts definitions/commands/release.md commands/release.md .claude-plugin engine/dist
git commit -m "build(platform): ship verified packages for every host"
```

---

### Task 14: Add One Cross-Platform Smoke Harness

**Files:**
- Create: `tests/e2e/run-platform-smoke.sh`
- Create: `tests/e2e/platform-claude.sh`
- Modify: `tests/e2e/platform-codex.sh`
- Modify: `tests/e2e/platform-gemini.sh`
- Modify: `tests/e2e/platform-opencode.sh`
- Modify: `engine/package.json`

**Interfaces:**
- Consumes: adapter installer, doctor, headless runtime, feature contract.
- Produces: one parameterized end-to-end acceptance harness and `npm run e2e:platforms`.

- [ ] **Step 1: Define the smoke harness contract**

Inputs:

```text
MJLOOP_E2E_PLATFORM=claude-code|codex|gemini-cli|opencode
MJLOOP_E2E_BINARY=/optional/absolute/path
MJLOOP_E2E_KEEP=1
```

The harness creates a temporary Git repository and:

1. installs the selected platform locally;
2. runs doctor;
3. initializes mjloop;
4. checks detected verify commands;
5. runs a one-file edit with a test;
6. proves engine-recorded verification;
7. runs a direct build cycle;
8. creates/approves a plan and builds `--next`;
9. reproduces and fixes a defect;
10. writes/searches memory;
11. verifies status/telemetry/history/preflight;
12. exercises stop and resume;
13. confirms protected-state handling;
14. starts and closes the cockpit;
15. uninstalls the platform integration;
16. proves `.mjloop/` and user files remain.

- [ ] **Step 2: Make platform wrappers data-only**

Each wrapper exports its platform id and runtime enable flag, then calls `run-platform-smoke.sh`. Platform-specific logic belongs in adapters, not duplicated shell scripts.

- [ ] **Step 3: Add timeout and cleanup guarantees**

Every process receives a bounded timeout. A trap:

```bash
trap cleanup EXIT INT TERM
```

must kill child sessions, close the cockpit, and remove the temporary repository unless `MJLOOP_E2E_KEEP=1`.

- [ ] **Step 4: Add the matrix script**

```json
{
  "scripts": {
    "e2e:platforms": "bash ../tests/e2e/run-platform-smoke.sh --installed"
  }
}
```

`--installed` runs only detected hosts and reports skipped hosts separately. CI release jobs require all four and treat a skip as failure.

- [ ] **Step 5: Run every available host and the full engine suite**

```bash
cd engine
npm run e2e:platforms
npm run test:compat
npm test
npm run typecheck
npm run build
npm run verify:ship
```

Expected: all installed adapters pass; release CI requires all four.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e engine/package.json
git commit -m "test(platform): exercise the full loop on every host"
```

---

### Task 15: Update User, Contributor, and Migration Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/about.md`
- Modify: `docs/about.ar.md`
- Modify: `docs/install.md`
- Modify: `docs/install.ar.md`
- Modify: `docs/usage.md`
- Modify: `docs/usage.ar.md`
- Modify: `CONTRIBUTING.md`
- Create: `docs/platforms.md`
- Create: `docs/platforms.ar.md`
- Create: `docs/migrating-from-claude-only.md`
- Modify: `docs/multi-platform-compatibility.md`

**Interfaces:**
- Consumes: final commands, capability matrix, installer behavior, doctor output, release process.
- Produces: accurate multi-platform installation, use, troubleshooting, migration, and contribution documentation.

- [ ] **Step 1: Rewrite product positioning without erasing Claude history**

README opening:

```markdown
# mjloop

A platform-neutral cycle engine for Claude Code, Codex, Gemini CLI, and OpenCode.
It keeps execution state and evidence in `.mjloop/`, while a platform adapter
translates the same commands, agents, skills, and safety rules to each host.
```

Keep a Claude marketplace installation section and add the universal installer section.

- [ ] **Step 2: Document exact command spelling per platform**

Provide a table for every command, for example:

| Logical command | Claude Code | Codex | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Build | `/mjloop:build` | `$mjloop-build` | `/mjloop:build` | `/mjloop-build` |

Generate this table from adapter metadata during docs verification so it cannot drift.

- [ ] **Step 3: Document safety equivalence honestly**

Explain:

- native hooks versus supervisor emulation;
- protected-write interception versus tamper detection;
- sequential emulation when host subagents are unavailable;
- capability refusals;
- why `.mjloop/` remains shared;
- why two platform sessions must not run concurrently against one project.

- [ ] **Step 4: Write the no-data-loss migration guide**

Sequence:

```bash
git status --short
cd engine && npm test && npm run typecheck && npm run verify:ship
mjloop platform detect
mjloop platform install --platform codex --scope local --dir .
mjloop platform doctor --dir .
```

State explicitly:

- existing Claude installation keeps working;
- `.mjloop/` is not moved;
- existing `CLAUDE.md` content outside markers is preserved;
- legacy `.claude/agents` remain in place;
- extension migration is opt-in and supports dry-run;
- rollback is platform uninstall, not deleting `.mjloop/`.

- [ ] **Step 5: Update contribution and release instructions**

Contributors must:

1. edit canonical definitions, never generated host files directly;
2. run `platform:check`;
3. run adapter unit/staged tests;
4. run Claude compatibility tests;
5. rebuild `dist`;
6. run `verify:ship`;
7. run real host smoke tests when adapter behavior changes.

- [ ] **Step 6: Add documentation assertions**

Extend tests so:

- every supported platform is named in English and Arabic platform docs;
- every logical command appears;
- current version and minimum tested host versions come from descriptors;
- old “Claude Code only” claims are absent except in migration/history sections;
- generated command tables match adapter metadata.

- [ ] **Step 7: Run docs and full release gate**

```bash
cd engine
npx vitest run tests/web/locales.test.ts tests/platform/feature-contract.test.ts
npm run platform:check
npm run test:compat
npm test
npm run typecheck
npm run build
npm run verify:ship
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add README.md CONTRIBUTING.md docs engine/tests
git commit -m "docs: publish the multi-platform migration guide"
```

---

### Task 16: Final Compatibility Audit and First Multi-Platform Release

**Files:**
- Create: `docs/superpowers/reviews/2026-07-29-mjloop-multi-platform-compatibility-review.md`
- Modify: versioned release files only after every gate passes.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: evidence-backed release audit and the first multi-platform release.

- [ ] **Step 1: Audit every protected feature against evidence**

The review contains one row per entry in `platforms/feature-contract.json` and columns:

```text
Feature | Claude | Codex | Gemini CLI | OpenCode | Evidence | Result
```

Allowed results:

- `PASS_NATIVE`
- `PASS_EMULATED`
- `BLOCKED`

No blank or narrative-only result is accepted.

- [ ] **Step 2: Run the complete static and packaged verification**

```bash
cd engine
npm run platform:check
npm run test:compat
npm test
npm run typecheck
npm run generate:platforms
npm run build
npm run verify:ship
```

Expected: PASS.

- [ ] **Step 3: Run the complete real-host matrix**

```bash
cd engine
MJLOOP_E2E_CLAUDE=1 \
MJLOOP_E2E_CODEX=1 \
MJLOOP_E2E_GEMINI=1 \
MJLOOP_E2E_OPENCODE=1 \
npm run e2e:platforms
```

Expected: all four adapters pass. Do not release a platform whose real smoke test was skipped.

- [ ] **Step 4: Test migration and rollback from the last Claude-only release**

In a temporary copy installed from tag `v0.4.1` or the actual last Claude-only release:

1. initialize a project;
2. create a plan, story, run, memory entry, and design-system file;
3. upgrade to the multi-platform version;
4. run Claude status/build;
5. install Codex and run status/build against the same state;
6. uninstall Codex;
7. prove Claude still runs;
8. compare all pre-upgrade `.mjloop/` artifacts and prove none disappeared.

- [ ] **Step 5: Review security and destructive boundaries**

Confirm:

- installer rejects path traversal and symlink escape;
- uninstaller removes only receipt-owned unchanged files;
- cockpit stays localhost/token protected;
- MCP project dir cannot escape the selected project through generated config;
- shell-based state tamper is detected;
- platform config merge preserves user permissions/providers/models;
- logs and receipts contain no credentials;
- every spawned process is terminated on cancellation and test failure.

- [ ] **Step 6: Write the compatibility review**

The report records exact commands, exit codes, tested host versions, native/emulated capabilities, unresolved limitations, and rollback proof. Any `BLOCKED` row prevents release.

- [ ] **Step 7: Cut the release**

Use the generalized release command only after:

```bash
git status --short
```

returns no changes and the review contains no `BLOCKED` result.

- [ ] **Step 8: Commit the audit before the version/tag commit**

```bash
git add docs/superpowers/reviews/2026-07-29-mjloop-multi-platform-compatibility-review.md
git commit -m "docs: audit multi-platform feature compatibility"
```

The release command creates the separate version/tag commit according to the repository’s release policy.

---

## 4. Phase Gates

### Gate A — Baseline

Required before platform abstraction:

- clean working tree;
- completed Milestone 8;
- all engine tests pass;
- typecheck passes;
- build passes;
- staged Claude shipment passes;
- feature contract matches the shipped distribution.

### Gate B — Claude reference adapter

Required before Codex:

- generated Claude distribution is semantically equal to the pre-migration distribution;
- all existing Claude E2E scripts pass;
- no `.mjloop/` schema migration is required;
- marketplace install still works;
- hook behavior is unchanged.

### Gate C — Each new adapter

Required before starting the next adapter:

- renderer unit tests pass;
- temporary staged install/upgrade/uninstall passes;
- capability doctor is accurate;
- real host smoke passes;
- Claude compatibility remains green;
- full engine suite and typecheck pass.

### Gate D — Release

Required before the first multi-platform tag:

- all four real-host smokes pass;
- migration from last Claude-only release preserves state;
- rollback removes only the selected adapter;
- feature audit has no blocked row;
- generated packages run from an empty staged tree;
- docs and versions match descriptors;
- working tree is clean.

## 5. Rollback Strategy

Rollback is adapter-scoped:

1. stop active cockpit/supervisor sessions;
2. run `mjloop platform uninstall --platform <id> --scope <scope> --dir <project>`;
3. preserve any modified generated file and report it;
4. leave `.mjloop/` untouched;
5. leave other platform integrations untouched;
6. run `mjloop platform doctor --dir <project>`;
7. use the previously working host against the same state.

Do not roll back by deleting `.mjloop/`, resetting the repository, or replacing whole user config files.

## 6. Success Criteria

The migration is complete only when:

1. The same project and `.mjloop/` state can be inspected and continued from Claude Code, Codex, Gemini CLI, or OpenCode.
2. All current tracks, gates, guards, evidence rules, specialists, memory, planning, telemetry, history, preflight, verification, and cockpit actions remain present.
3. Claude Code passes every pre-migration compatibility and E2E test.
4. Every new platform passes renderer, staged install, and real-runtime smoke tests.
5. Unsupported host capabilities are refused or explicitly emulated; none are silently skipped.
6. Installation, upgrade, uninstall, and rollback preserve user files and `.mjloop/`.
7. Canonical definitions are the only manually maintained command/agent/skill source.
8. All generated packages are reproducible and runnable from a clean staged tree.
9. The compatibility audit contains no `BLOCKED` result.
