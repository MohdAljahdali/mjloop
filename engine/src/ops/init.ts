import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultConfig, type Verify } from '../schemas/config.js'
import type { ProposedProfile } from '../schemas/project-profile.js'
import { initialState } from '../schemas/state.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { loadConfig, writeConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { acceptProfile, listAcceptedRevisions, writeProposedProfile } from '../store/project-profile-store.js'
import type { Clock } from '../store/state-store.js'
import { detectComponents } from './project-profile.js'

export const CLAUDE_MD_SECTION = '## mjloop'

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_SECTION}

This project uses the \`mjloop\` plugin. Execution state lives in \`.mjloop/\`.

- \`/mjloop:edit <request>\` — small, well-scoped change (one cycle)
- \`/mjloop:plan <idea>\` — turn an idea into an approved plan broken into stories
- \`/mjloop:build <what to build | P001-S02 | --next>\` — multi-cycle build, optionally against a story
- \`/mjloop:fix <problem>\` — reproduce a defect, find the root cause, fix it
- \`/mjloop:status\` — current track, cycle, and latest evidence
- \`/mjloop:stop [reason]\` — halt the run and write a report
- \`/mjloop:resume\` — continue a run that was interrupted
- \`/mjloop:design-sync\` — extract the project's design system for the UI agents
- \`/mjloop:config [get | set <key> <value>]\` — read or change this project's orchestration settings
- \`/mjloop:web\` — dashboard: queue runs and watch each one in a terminal
- \`/mjloop:add agent|skill|track <name>\` — scaffold a new element

\`.mjloop/state.json\` is owned by the mjloop MCP server. Never edit it by hand.
`

/** What the component scan at the end of `initLoop` came back with. */
export interface InitProfileResult {
  /** Component ids in the proposal this call wrote. Empty when the scan failed. */
  proposedComponents: string[]
  /**
   * The accepted revision in effect *after* this call, not the one it wrote.
   *
   * Read back from `.mjloop/profile/accepted/` rather than reported from the
   * acceptance below, so the field answers one question — what routes runs from
   * here — whether the revision was accepted a moment ago, months ago, or never.
   */
  acceptedRevision: number | null
  /**
   * Why the scan produced nothing, or null.
   *
   * The scan is allowed to fail and `mjloop init` is not, so the failure has to
   * land somewhere a person can see it. Silently returning no components would
   * be indistinguishable from a project that genuinely declares none.
   */
  error: string | null
}

export interface InitResult {
  /** Paths created by this call, relative to the project root. */
  created: string[]
  verify: Verify
  alreadyInitialised: boolean
  profile: InitProfileResult
}

/** Read verify commands off package.json scripts. Absent script -> null. */
export async function detectVerifyCommands(projectDir: string): Promise<Verify> {
  const empty: Verify = { test: null, lint: null, build: null }
  let scripts: Record<string, unknown>
  try {
    const raw = await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> }
    scripts = parsed.scripts ?? {}
  } catch {
    return empty
  }
  return {
    test: typeof scripts.test === 'string' ? 'npm test' : null,
    lint: typeof scripts.lint === 'string' ? 'npm run lint' : null,
    build: typeof scripts.build === 'string' ? 'npm run build' : null,
  }
}

export async function initLoop(projectDir: string, now: Clock = () => new Date()): Promise<InitResult> {
  const paths = resolveLoopPaths(projectDir)
  const verify = await detectVerifyCommands(projectDir)

  if (await exists(paths.state)) {
    await ensureClaudeMdSection(projectDir)
    // Re-proposed on every call, not only on a fresh one: `mjloop init` is the
    // only scan this feature ships, so a project that grew a `packages/api`
    // since it was provisioned has no other way to be seen. The proposal is
    // disposable by construction and nothing routes off it, so overwriting one
    // costs nothing.
    return { created: [], verify, alreadyInitialised: true, profile: await proposeProfile(projectDir, now) }
  }

  const created: string[] = []
  for (const dir of [paths.root, paths.plans, paths.runs, paths.memory]) {
    await fs.mkdir(dir, { recursive: true })
    created.push(path.relative(projectDir, dir))
  }

  await writeJsonAtomic(paths.state, initialState(now()))
  created.push(path.relative(projectDir, paths.state))

  await writeConfig(projectDir, defaultConfig(verify))
  created.push(path.relative(projectDir, paths.config))

  if (await ensureClaudeMdSection(projectDir)) created.push('CLAUDE.md')

  // Last, and deliberately so — see `proposeProfile`.
  return { created, verify, alreadyInitialised: false, profile: await proposeProfile(projectDir, now) }
}

/**
 * Scan the project and write `.mjloop/profile/proposed.json`.
 *
 * Two rules, and both are about position rather than behaviour.
 *
 * **It runs last.** State and config are what `mjloop init` exists to produce;
 * the component map is a convenience laid on top of them. Running the walk
 * first would mean a project whose tree cannot be listed never gets a
 * `.mjloop/` at all, which is a strictly worse failure than getting one with no
 * component map in it.
 *
 * **It cannot fail the init.** Everything below is swallowed for the same
 * reason: this walk runs against a host project's working tree — uncommitted
 * work, vendored checkouts, directories the user cannot read — and none of that
 * is a reason to refuse to provision the loop. The failure is reported in the
 * result instead, because a caller that is told "no components" and a caller
 * that is told "the scan died" do very different things next.
 */
async function proposeProfile(projectDir: string, now: Clock): Promise<InitProfileResult> {
  let proposedComponents: string[] = []
  let error: string | null = null
  try {
    const proposed = await detectComponents(projectDir, now)
    await writeProposedProfile(projectDir, proposed)
    // Assigned before the acceptance is attempted, so a config that no longer
    // parses is reported as an error *and* the proposal it did not stop is
    // still reported as written.
    proposedComponents = proposed.components.map((component) => component.id)
    await autoAcceptFirstRevision(projectDir, proposed, now)
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  let acceptedRevision: number | null = null
  try {
    acceptedRevision = (await listAcceptedRevisions(projectDir)).at(-1) ?? null
  } catch {
    // Swallowed on the same grounds as the scan above: an unreadable
    // `accepted/` directory is a thing to report as "no revision seen", never a
    // reason for `mjloop init` to fail.
  }

  return { proposedComponents, acceptedRevision, error }
}

/**
 * Accept the scan's own components, but only for a project that asked and only
 * when nothing is accepted yet.
 *
 * `orchestration.profile.auto_accept` says an *unmapped* project may take a
 * directory walk's word for its own shape. It does not say a later walk may
 * replace a map that is already routing runs: a re-acceptance on every init
 * would let the component map drift with whatever happens to be in the working
 * tree — including a half-finished package somebody has not committed — and
 * every accepted revision is immutable precisely so that cannot happen.
 */
async function autoAcceptFirstRevision(projectDir: string, proposed: ProposedProfile, now: Clock): Promise<void> {
  const config = await loadConfig(projectDir)
  if (!config.orchestration.profile.auto_accept) return
  if ((await listAcceptedRevisions(projectDir)).length > 0) return

  await acceptProfile(
    projectDir,
    {
      components: proposed.components,
      // Named rather than left as "mjloop", because `acceptedBy` is the only
      // record of *why* a revision exists, and "nobody looked at this, the
      // config said it was fine" is the answer for these.
      by: 'mjloop init (orchestration.profile.auto_accept)',
      generatedAt: proposed.generatedAt,
      expectRevision: null,
    },
    now,
  )
}

/** Append the loop section to CLAUDE.md unless it is already there. */
export async function ensureClaudeMdSection(projectDir: string): Promise<boolean> {
  const file = path.join(projectDir, 'CLAUDE.md')
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.includes(CLAUDE_MD_SECTION)) return false

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await fs.writeFile(file, `${existing}${separator}${CLAUDE_MD_BLOCK}`, 'utf8')
  return true
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
