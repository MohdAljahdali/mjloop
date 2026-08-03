import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HISTORY_DEFAULT_LIMIT } from '../ops/history.js'
import { preflightEstimate, type Preflight } from '../ops/preflight.js'
import { readProjectSkills } from '../ops/project-skills.js'
import { rosterValidity, type RosterValidity } from '../ops/roster.js'
import { UnknownTrackError } from '../ops/run.js'
import { readTelemetry, type Telemetry } from '../ops/telemetry.js'
import { readVerifyLedger } from '../ops/verify.js'
import { AgentResultSchema, RosterSchema } from '../schemas/contract.js'
import type { FeatureBrief, FeatureBriefStatus } from '../schemas/feature.js'
import { FindingSchema, type State } from '../schemas/state.js'
import { ManifestSchema, PlanFrontmatterSchema, StoryFrontmatterSchema } from '../schemas/plan.js'
import { SkillManifestSchema, type SkillManifest } from '../schemas/skill-selection.js'
import type { LedgerEntry } from '../schemas/verify.js'
import { configRevision } from '../store/config-mutation.js'
import { loadConfig, ConfigMissingError } from '../store/config-store.js'
import {
  listFeatureRevisions,
  listFeatureSummaries,
  readFeatureBrief,
  type FeatureSummary,
} from '../store/feature-store.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { listMemories, readMemory } from '../store/memory-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { findPlanDir, listStories, type Story } from '../store/plan-store.js'
import { readAcceptedProfile, readProposedProfile } from '../store/project-profile-store.js'
import { listAgents, projectAgentsDir, type AgentDoc } from '../store/agent-store.js'
import { acceptanceDigest, listAcceptances } from '../store/skill-acceptance-store.js'
import { listPackages, type UnreadablePackage } from '../store/skill-library-store.js'
import type { ProjectSkillAcceptance } from '../schemas/skill-acceptance.js'
import type { SkillPackage } from '../schemas/skill-library.js'
import type { ProjectSkillOnDisk, UnreadableProjectSkill } from '../schemas/project-skills.js'
import { StateStore } from '../store/state-store.js'
import type { Config } from '../schemas/config.js'
import type { ProjectComponent } from '../schemas/project-profile.js'
import type { AgentView, AgentsView } from './protocol.js'

/**
 * Everything the read API serves.
 *
 * Every function here is **non-destructive**, and that is a property with a
 * test: `read.test.ts` hashes every file under `.mjloop/`, calls all of these,
 * and re-hashes. A poller running once a second is the last thing that should
 * be writing to somebody's project.
 *
 * That rules out `readPlan`, which repairs clobbered frontmatter by rewriting
 * the file. Plans are read here from `PLAN.md` directly and their stories from
 * `listStories`, which skips a file it cannot parse rather than mending it.
 *
 * It also decides which half of `ops/verify.ts` this file may touch. That module
 * exports the ledger *reader* beside the executor that spawns a shell command
 * and takes the project verify lock; only the reader belongs on a wire a browser
 * can pull. `tests/web/boundary.test.ts` names `verifyRun` and `worktreeDigest`
 * in its `FORBIDDEN` list with the reason attached, so importing the executor
 * beside the reader fails a test rather than passing review.
 */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(what)
    this.name = 'NotFoundError'
  }
}

/* ── state ────────────────────────────────────────────────────────────────── */

export interface StateView {
  state: State
  recovered: boolean
}

export async function readState(projectDir: string): Promise<StateView> {
  try {
    const { state, recovered } = await new StateStore(projectDir).read()
    return { state, recovered }
  } catch {
    throw new NotFoundError('state')
  }
}

/* ── config ───────────────────────────────────────────────────────────────── */

export interface ConfigView {
  /** The file as written, comments intact. The page shows it and never sets it. */
  raw: string | null
  /** SHA-256 of `raw`, used as the compare-and-swap token for edits. */
  revision: string | null
  parsed: Config | null
  /** True when the file exists but does not parse. The text is in `raw`. */
  invalid: boolean
}

export async function readConfigView(projectDir: string): Promise<ConfigView> {
  const paths = resolveLoopPaths(projectDir)
  const raw = await fs.readFile(paths.config, 'utf8').catch(() => null)
  try {
    return {
      raw,
      revision: raw === null ? null : configRevision(raw),
      parsed: await loadConfig(projectDir),
      invalid: false,
    }
  } catch (error) {
    // A missing config is not an error — a project may be mid-provisioning.
    // Anything else means the file is there and unusable, which is exactly what
    // the Config tab exists to show.
    if (error instanceof ConfigMissingError) return { raw, revision: null, parsed: null, invalid: false }
    return { raw, revision: raw === null ? null : configRevision(raw), parsed: null, invalid: true }
  }
}

/* ── the project profile ──────────────────────────────────────────────────── */

export interface ProfileView {
  /** The accepted revision, or null when nothing has been accepted. */
  revision: number | null
  acceptedAt: string | null
  acceptedBy: string | null
  /**
   * The accepted revision's components, and *only* an accepted revision's.
   *
   * A proposal's components are deliberately absent: nothing routes off a
   * proposal, and handing the page a component map it would draw under the same
   * heading is how a suggestion starts reading as a decision.
   */
  components: ProjectComponent[]
  /** When the scan behind the current proposal ran; null when there is none. */
  proposedAt: string | null
  /** True when a proposal exists and maps this project differently. */
  proposalDiffers: boolean
}

/**
 * What this project is routed by, and whether a newer scan disagrees.
 *
 * A read, like everything else in this file, and one whose read-only-ness is
 * load-bearing rather than incidental: accepting a component map activates
 * routing for every later run, which is precisely the class of write
 * `web/writes.ts` denies the browser permanently. So this reports what was
 * accepted, reports that a proposal differs, and offers no way to resolve the
 * difference — resolving it is a command.
 *
 * An accepted revision that no longer parses raises rather than reading as
 * "unmapped", and that asymmetry with the proposal is deliberate — it is
 * `project-profile-store.ts`'s, restated here because it decides what a browser
 * sees: a proposal is regenerated by the next scan, an accepted revision is
 * immutable and load-bearing, and answering "no component map" for one that is
 * sitting on disk would route every later run as though the project had never
 * been mapped.
 */
export async function readProfileView(projectDir: string): Promise<ProfileView> {
  const [accepted, proposed] = await Promise.all([
    readAcceptedProfile(projectDir),
    readProposedProfile(projectDir),
  ])
  // Never scanned and never accepted is a project the operator is asking about
  // something that is not there, not this server failing to read something it
  // should have been able to read — the same call `readPreflightEstimate`
  // makes for a track a project does not define.
  if (accepted === null && proposed === null) throw new NotFoundError('profile')

  return {
    revision: accepted?.revision ?? null,
    acceptedAt: accepted?.acceptedAt ?? null,
    acceptedBy: accepted?.acceptedBy ?? null,
    components: accepted?.components ?? [],
    proposedAt: proposed?.generatedAt ?? null,
    proposalDiffers:
      proposed !== null && componentFingerprint(proposed.components) !== componentFingerprint(accepted?.components ?? []),
  }
}

/**
 * Two component maps compared by what they *say*, not by how they serialise.
 *
 * `JSON.stringify` would do the job today and would be the wrong instrument:
 * key order is not part of a record's meaning, a schema is free to hand its
 * fields back in whatever order it likes, and this answer decides whether a
 * person is told to go and look at a change. Every field the record carries is
 * named here, so a field added to `ProjectComponentSchema` and forgotten here
 * is a difference this cannot see — which is what the verification-changed test
 * in `read.test.ts` is standing guard over.
 */
function componentFingerprint(components: readonly ProjectComponent[]): string {
  return components
    .map((component) =>
      [
        component.id,
        component.root,
        component.technology,
        component.verification.test ?? '',
        component.verification.lint ?? '',
        component.verification.build ?? '',
        component.skillTags.join(' '),
      ].join('\u0000'),
    )
    .join('\n')
}

/* ── the shared skill library and this project's acceptances ─────────────── */

/**
 * One acceptance, plus the compare-and-swap token the `skill.agents` write
 * door checks it against.
 *
 * Named `recordDigest`, never `digest`: `ProjectSkillAcceptanceSchema` already
 * has a `digest` field — the *package* content digest `acceptSkill` pins
 * (`schemas/skill-acceptance.ts:42`) — and `{ ...record, digest: ... }` would
 * silently overwrite it rather than error, since both are `string`. That
 * collision is exactly what broke the Skills panel's package join before this
 * field had its own name.
 *
 * Not a field on `ProjectSkillAcceptanceSchema` itself: the schema is what
 * `acceptSkill` validates and persists, and `acceptanceDigest` is a hash *over*
 * that record, computed the same way `configRevision` is computed over
 * `config.yaml`'s raw text — a field that recorded its own hash would have to
 * be excluded from the hash it recorded, which is the kind of self-reference
 * `acceptanceDigest`'s own doc comment already rejected a counter revision to
 * avoid.
 */
export type AcceptanceView = ProjectSkillAcceptance & { recordDigest: string }

export interface SkillsView {
  /**
   * Every package this machine's library holds — source, revision, license,
   * audit. Once S07's `mjloop-cli skills import` has run, this *is* the
   * import report: `audit.state`/`audit.findings` carry inspection's
   * findings plus one line recording the sandbox outcome (see
   * `cli/index.ts#sandboxFinding`), because `writePackage` is only ever
   * reached from a passed audit — there is no separate "import report" object
   * to project alongside the package it produced.
   */
  packages: SkillPackage[]
  /**
   * A digest directory this walk could not turn into a record, and why.
   *
   * Surfaced rather than dropped, the same reason `mjloop-cli skills list`
   * shows it — and newly meaningful now that `skills import` can actually
   * write real content into this machine-wide directory, so an entry here can
   * be evidence of an interrupted or corrupted import rather than only ever
   * being another project's problem.
   */
  unreadable: UnreadablePackage[]
  /**
   * This project's own acceptances — digest, components, agents, policy,
   * status — each carrying its own `recordDigest` (`AcceptanceView`, above),
   * which `skill.agents` hands back unmodified as the token proving which
   * acceptance the click was made against.
   */
  acceptances: AcceptanceView[]
  /**
   * The skills this project's own checkout holds, in `.claude/skills/`.
   *
   * Served beside the acceptances rather than folded into them because the
   * two answer different questions: this list is what the *session* can load,
   * the acceptances are what *mjloop* routes work to. A page that had only
   * the second told a project full of skills that it had none, which is the
   * defect this field closes. The join between them — is this skill routed? —
   * is made client-side against `skillId`, the same way `joinAcceptances`
   * joins an acceptance to its library package.
   */
  onDisk: ProjectSkillOnDisk[]
  /** A `SKILL.md` the walk could not read, and why. Surfaced, never dropped. */
  onDiskUnreadable: UnreadableProjectSkill[]
}

/**
 * The library and this project's acceptances of it, read-only.
 *
 * `mjloop-cli skills accept|disable|enable|remove` is where the decision is
 * made; this route reports it and nothing more — `web/writes.ts`'s header
 * permanently denies the browser any write of this class, because accepting
 * a skill changes what every later dispatch is told to use. `listPackages`
 * and `listAcceptances` are themselves pure reads that execute nothing under
 * a package's `content/`, so this function performs no work beyond the two
 * walks it names.
 *
 * An empty library and a project with no acceptances both answer with empty
 * arrays rather than a 404 — that is the state every machine and every
 * project start in, the same position `readFeatures` takes on a project that
 * has raised no feature yet.
 */
export async function readSkillsView(projectDir: string): Promise<SkillsView> {
  // `listPackages` reports the entries it could not read rather than throwing
  // on them, which is what keeps one damaged import — possibly another
  // project's, since the library is machine-wide — from turning this whole
  // read into a 500. `unreadable` carries exactly those entries through to the
  // wire rather than silently dropping them.
  const [library, acceptances, onDisk] = await Promise.all([
    listPackages(projectDir),
    listAcceptances(projectDir),
    readProjectSkills(projectDir),
  ])
  return {
    packages: library.packages,
    unreadable: library.unreadable,
    acceptances: acceptances.map((record) => ({ ...record, recordDigest: acceptanceDigest(record) })),
    onDisk: onDisk.skills,
    onDiskUnreadable: onDisk.unreadable,
  }
}

/* ── agents ───────────────────────────────────────────────────────────────── */

/**
 * The plugin's own `agents/`, resolved the way `web/cli.ts:84` resolves
 * `ENGINE_DIR` — except this module sits one directory deeper than `cli.ts`
 * relative to the plugin root: `cli.ts`'s `'../../'` lands on the engine root
 * (`engine/`), and the plugin's `agents/` sits one level above *that*, so this
 * needs a third `..`. Verified directly: from both `engine/src/web/` under
 * vitest and `engine/dist/web/` in a build, three levels up lands on
 * `<repo-root>/agents/`, not `engine/agents/` (which does not exist).
 */
export const PLUGIN_AGENTS_DIR = fileURLToPath(new URL('../../../agents/', import.meta.url))

/**
 * The two agent directories, side by side and never merged.
 *
 * A project agent shadows a plugin one of the same name, and folding them into
 * one list would hide exactly that. `path` is dropped on the way out: it is an
 * absolute path, which the page has no use for and must not display.
 */
export async function readAgentsView(projectDir: string): Promise<AgentsView> {
  const [project, plugin] = await Promise.all([
    listAgents(projectAgentsDir(projectDir), 'project'),
    listAgents(PLUGIN_AGENTS_DIR, 'plugin'),
  ])
  const view = ({ path: _path, ...rest }: AgentDoc): AgentView => rest
  return {
    project: project.agents.map(view),
    plugin: plugin.agents.map(view),
    // The plugin's own unreadable files are not this project's problem to
    // report — a broken plugin file is a bug in the plugin, and a project
    // cannot act on it.
    unreadable: project.unreadable.map((entry) => ({ path: path.basename(entry.path) })),
  }
}

/* ── feature briefs ───────────────────────────────────────────────────────── */

/**
 * One revision of a feature, as a reader should see it.
 *
 * `status` is not the field on disk. A stored revision only ever says `draft`
 * or `approved`, because marking one `superseded` would mean writing to the
 * immutable record being described — so the third status is *derived*, and this
 * is one of the two places that derivation happens (`feature-store.ts` does it
 * for the callers that read a single revision). The rule is exactly "a higher
 * revision of this feature exists", which is why nothing below is read to
 * decide it: every revision under the latest is superseded by definition, so
 * the answer comes from the revision *list* and costs no extra file.
 */
export interface FeatureRevisionView {
  revision: number
  status: FeatureBriefStatus
}

export interface FeatureDetail {
  /** The latest revision, exactly as it is on disk. */
  brief: FeatureBrief
  /** Its lifecycle status — never `superseded`, since nothing sits above it. */
  status: FeatureBriefStatus
  /** Every revision of this feature, ascending. The history is the audit trail. */
  revisions: FeatureRevisionView[]
  /**
   * The fingerprint of the brief above, which the page hands back with an
   * approval.
   *
   * Served for the same reason `/api/config` serves its revision hash: the
   * revision *number* cannot move while a draft is editable, so a `feature.approve`
   * that only carried the number would be approving whatever the brief says by
   * the time the click lands rather than what this response actually showed.
   */
  digest: string
}

/**
 * Every feature this project has raised.
 *
 * `FeatureSummary` goes out as the store shapes it rather than being copied
 * into a parallel type, the way `readTelemetryReport` passes `Telemetry`
 * through: every field is already something a reader wants, and a second
 * declaration of the same record is a second thing to keep in step.
 *
 * An empty list rather than a `NotFoundError`, which is where this parts
 * company with `readProfileView` one section above. "Nothing has been mapped"
 * changes how every later run is routed and must not read as a quiet default;
 * "no feature has been raised yet" is the ordinary state of every project on
 * the day it is provisioned.
 *
 * A brief that no longer parses raises, and is not skipped. That is the store's
 * asymmetry restated here because it decides what a browser sees: a brief is
 * regenerated by nothing, and quietly dropping one would show a feature list
 * that is missing the very record somebody is looking for.
 */
export async function readFeatures(projectDir: string): Promise<FeatureSummary[]> {
  return await listFeatureSummaries(projectDir)
}

export async function readFeatureDetail(projectDir: string, featureId: string): Promise<FeatureDetail> {
  const record = await readFeatureBrief(projectDir, featureId)
  if (record === null) throw new NotFoundError('feature')
  const revisions = await listFeatureRevisions(projectDir, featureId)

  return {
    brief: record.brief,
    status: record.status,
    revisions: revisions.map((revision) => ({
      revision,
      status: revision < record.brief.revision ? 'superseded' : record.status,
    })),
    digest: record.digest,
  }
}

/* ── plans and stories ────────────────────────────────────────────────────── */

export interface ApprovalView {
  decision: string
  by: string
  at: string
  note: string | null
}

export interface StoryDetail {
  id: string
  title: string
  status: string
  ui: boolean
  depends_on: string[]
  acceptance: string[]
  /** The run directory holding the proof this story is done. Null until it is. */
  evidence: string | null
  /**
   * The story file's markdown body. Same policy as `PlanDetail.body`: whole,
   * unbounded, rendered through `verbatim()`; the page escapes nothing. There
   * is no `CYCLE_HANDOFF_MAX`-style ceiling here because there is none on the
   * plan body either, and a story is served from the same array.
   */
  body: string
}

export interface PlanDetail {
  id: string
  title: string
  approval: ApprovalView | null
  /** `PLAN.md`'s body. Rendered through `verbatim()`; the page escapes nothing. */
  body: string
  /** The plan-critic's review. Nothing in `engine/src` reads this file today. */
  review: string | null
  stories: StoryDetail[]
}

export async function readPlanDetail(projectDir: string, planId: string): Promise<PlanDetail> {
  let dir: string
  try {
    dir = await findPlanDir(projectDir, planId)
  } catch {
    throw new NotFoundError('plan')
  }

  const raw = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8').catch(() => null)
  const parsed = raw === null ? null : PlanFrontmatterSchema.safeParse(parseFrontmatter(raw).data)
  const frontmatter = parsed?.success === true ? parsed.data : null

  const [review, stories, manifestTitle] = await Promise.all([
    fs.readFile(path.join(dir, 'REVIEW.md'), 'utf8').catch(() => null),
    readStoryDetails(projectDir, planId),
    readManifestTitle(dir),
  ])

  return {
    id: planId,
    title: frontmatter?.title ?? manifestTitle ?? path.basename(dir),
    // The whole record — `decision`, `by`, `at`, `note` — where the snapshot
    // carries only the decision. An approval is auditable or it is a flag.
    approval: frontmatter?.approval ?? null,
    body: raw === null ? '' : parseFrontmatter(raw).body,
    review,
    stories,
  }
}

/**
 * Read from the story files rather than the manifest: `acceptance` and
 * `evidence` live in story frontmatter and are deliberately absent from
 * `ManifestEntry`, so the manifest cannot answer this.
 */
async function readStoryDetails(projectDir: string, planId: string): Promise<StoryDetail[]> {
  const stories = await listStories(projectDir, planId).catch(() => [])
  return stories.map((story) => toStoryDetail(story))
}

/**
 * Takes the whole `Story`, not just its frontmatter: `readPlanDetail` embeds
 * this same array in `PlanDetail.stories`, and `readStoryDetail` below finds
 * one element of it. A body added to one shape and not the other would ship
 * two divergent views of the same record — this function is the one place
 * that cannot happen.
 */
function toStoryDetail({ frontmatter, body }: Story): StoryDetail {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    status: frontmatter.status,
    ui: frontmatter.ui,
    depends_on: frontmatter.depends_on,
    acceptance: frontmatter.acceptance,
    evidence: frontmatter.evidence,
    body,
  }
}

export async function readStoryDetail(projectDir: string, storyId: string): Promise<StoryDetail> {
  const found = (await readStoryDetails(projectDir, storyId.slice(0, 4))).find((story) => story.id === storyId)
  if (found === undefined) throw new NotFoundError('story')
  return found
}

async function readManifestTitle(dir: string): Promise<string | null> {
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')))
    return parsed.success ? parsed.data.title : null
  } catch {
    return null
  }
}

/* ── transcripts ──────────────────────────────────────────────────────────── */

/**
 * A job's durable transcript, `.mjloop/web/transcripts/<jobId>.log`, exactly
 * as `JobQueue.writeTranscriptChunk` appended it — raw pty bytes, unbounded,
 * for the same reason `PlanDetail.body` is: the writer applies no ceiling of
 * its own, so a reader that invented one would be trimming from the wrong end
 * of a decision that belongs to the write side.
 *
 * A `fs.readFile` and nothing else — the file is produced by `JobQueue`, on
 * the process actually running the job, never by this function. That is what
 * keeps it inside the boundary `read.test.ts` polices: hashing every file
 * under `.mjloop/` around every reader in this module only proves a poll
 * never writes if none of them can materialise the thing they were asked to
 * read.
 */
export async function readTranscript(projectDir: string, jobId: string): Promise<string> {
  const file = path.join(resolveLoopPaths(projectDir).webTranscripts, `${jobId}.log`)
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    throw new NotFoundError('transcript')
  }
}

/* ── runs ─────────────────────────────────────────────────────────────────── */

export interface RunSummary {
  id: string
  /** Split out of the directory name, which is `<run_id>--<story|adhoc>--<track>`. */
  story: string | null
  track: string | null
  cycles: number
  halted: boolean
}

export async function readRuns(projectDir: string): Promise<RunSummary[]> {
  const runs = resolveLoopPaths(projectDir).runs
  const names = await fs
    .readdir(runs, { withFileTypes: true })
    .then((found) => found.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => [])

  const out: RunSummary[] = []
  // Newest first: run ids sort lexicographically because they open with a timestamp.
  for (const name of names.sort().reverse()) {
    const inside = await fs.readdir(path.join(runs, name)).catch((): string[] => [])
    const [, story, track] = name.split('--')
    out.push({
      id: name,
      story: story === undefined || story === 'adhoc' ? null : story,
      track: track ?? null,
      cycles: inside.filter((entry) => entry.startsWith('cycle-')).length,
      halted: inside.includes('HALT.md'),
    })
  }
  return out
}

/**
 * One story's own execution history: every run directory whose name carries
 * this story's id, in the same newest-first order `readRuns` already returns,
 * over the same convention `RunSummary.story` already documents — parsed out
 * of the run *directory name* (`<run_id>--<story|adhoc>--<track>`), never
 * stored against a story anywhere on disk.
 *
 * This route has no consumer yet, and that is a fact about today's tree, not
 * a plan for one: `panels/stories.js` still fetches every run on `/api/runs`
 * and filters to `entry.story === story.id` itself — this is that same
 * filter made available server side, not a replacement for it, and nothing
 * has been moved. It lands ahead of the caller that would retire the
 * client-side filter because B11 is the one commit in this milestone that
 * widens a schema and a wire shape at once (see the design doc's B11 note);
 * wiring `panels/stories.js` to it is separate, later work. Do not delete the
 * client-side filter on the strength of this comment, and do not delete this
 * route on the strength of `panels/stories.js`'s — `tests/web/api.test.ts`
 * and the read-side tests below pin it independent of any consumer.
 */
export async function readStoryRuns(projectDir: string, storyId: string): Promise<RunSummary[]> {
  const runs = await readRuns(projectDir)
  return runs.filter((run) => run.story === storyId)
}

export interface RunDetail {
  id: string
  /** The halt report, verbatim. Null when the run did not halt. */
  halt: string | null
  cycles: number[]
}

export async function readRunDetail(projectDir: string, runId: string): Promise<RunDetail> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId)
  const inside = await fs.readdir(dir).catch(() => null)
  if (inside === null) throw new NotFoundError('run')

  return {
    id: runId,
    halt: await fs.readFile(path.join(dir, 'HALT.md'), 'utf8').catch(() => null),
    cycles: inside
      .filter((entry) => /^cycle-\d+$/.test(entry))
      .map((entry) => Number(entry.slice('cycle-'.length)))
      .sort((a, b) => a - b),
  }
}

/**
 * This run's pinned skill routing decision — `skill-selection.json`, written
 * once by `runStart` beside `verify-pinned.json` — or `null` when the run
 * pinned none.
 *
 * A read of a file the engine itself writes once and never edits, so there is
 * nothing here for a browser to invent or mutate: this route can only ever
 * report the manifest a run started with, exactly as `readCycleDetail` reports
 * the handoff a cycle closed with. `null` is not an error — most runs today
 * name no feature at all, and `pinSkillManifest` pins nothing for them — so a
 * missing manifest reads the same as an existing one that failed to parse: the
 * absence of a decision, not a defect in reading one.
 *
 * The run directory's own existence is still checked and still a 404: an
 * unknown run id is the operator asking about something that was never
 * started, which is a different fact from "this run started and pinned
 * nothing."
 */
export async function readSkillManifest(projectDir: string, runId: string): Promise<SkillManifest | null> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId)
  const exists = await fs.readdir(dir).catch(() => null)
  if (exists === null) throw new NotFoundError('run')
  return readJson(path.join(dir, 'skill-selection.json'), SkillManifestSchema)
}

/**
 * How many ledger rows one cycle may put on the wire.
 *
 * `cycle-NN/verify/index.json` gains a row per invocation and a cycle can verify
 * as many times as its agents ask to, so the array has no ceiling of its own.
 * This document is what the Evidence tab re-fetches every time `revisions.cycle`
 * moves — roughly once a second while the run is live — so an unbounded array
 * here is a payload that grows for the length of the cycle and is re-serialised
 * at that rate. The newest rows are kept: they are the ones the cycle's verdict
 * is about to rest on.
 */
export const CYCLE_VERIFY_MAX = 50

/**
 * The ceiling on the handoff body this reader will carry.
 *
 * `writeHandoff` truncates at 6 000 bytes, so a handoff the engine wrote is
 * already bounded and this cap never fires. It exists for the one it did not
 * write: `handoff.md` is an ordinary file in an ordinary directory that a person
 * or an agent can replace, and the same once-a-second re-fetch applies to
 * whatever is found there.
 */
export const CYCLE_HANDOFF_MAX = 12_000

export interface CycleDetail {
  cycle: number
  /**
   * Agents drafted, and — the part recoverable from nowhere else — the ones the
   * leader skipped, with its stated reason.
   */
  roster: { selected: string[]; skipped: { agent: string; reason: string }[] } | null
  findings: { severity: string; file: string; line: number; claim: string }[]
  agents: { agent: string; result: unknown }[]
  /**
   * What the engine executed for this cycle, from `cycle-NN/verify/index.json`.
   *
   * At most `CYCLE_VERIFY_MAX` rows, oldest first. The pin's drift marker
   * (`source`, `live_command`) and the `queued` phase are fields on the entry
   * rather than a second channel, which is why an operator who edited
   * `config.yaml` mid-run can see which command actually ran without this file
   * gaining a route, a reader, or any knowledge of the pin.
   */
  verify: LedgerEntry[]
  /** Rows on disk, so `CYCLE_VERIFY_MAX` is visible rather than silent. */
  verify_total: number
  /**
   * `cycle-NN/handoff.md`, verbatim. Null when the cycle has none: every cycle
   * closed before the handoff existed, and any cycle whose handoff write failed
   * — `cycleAdvance` reports that as `handoff: null` rather than throwing, so
   * the absence is expected here too.
   */
  handoff: string | null
  /** True when `CYCLE_HANDOFF_MAX` cut the body above. */
  handoff_truncated: boolean
}

export async function readCycleDetail(projectDir: string, runId: string, cycle: number): Promise<CycleDetail> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId, `cycle-${String(cycle).padStart(2, '0')}`)
  const inside = await fs.readdir(dir).catch(() => null)
  if (inside === null) throw new NotFoundError('cycle')

  const roster = await readJson(path.join(dir, 'roster.json'), RosterSchema)
  const findings = await readJson(path.join(dir, 'findings.json'), FindingSchema.array())
  // Absence is the ordinary case, not an error: every cycle of every run that
  // predates the ledger has no `verify/` directory at all.
  const ledger = await readVerifyLedger(dir)
  const handoff = await fs.readFile(path.join(dir, 'handoff.md'), 'utf8').catch(() => null)

  const agents: { agent: string; result: unknown }[] = []
  for (const entry of inside.filter((name) => name.endsWith('.json')).sort()) {
    if (entry === 'roster.json' || entry === 'findings.json') continue
    // Parsed with the engine's own schema, and a file that fails to parse is
    // skipped rather than fatal — the same rule the snapshot already applies to
    // an unreadable plan. One bad result must not blank the whole cycle.
    const result = await readJson(path.join(dir, entry), AgentResultSchema)
    if (result !== null) agents.push({ agent: entry.replace(/\.json$/, ''), result })
  }

  return {
    cycle,
    roster:
      roster === null
        ? null
        : {
            selected: roster.selected,
            skipped: Object.entries(roster.skipped).map(([agent, reason]) => ({ agent, reason })),
          },
    findings: findings ?? [],
    agents,
    verify: ledger.slice(-CYCLE_VERIFY_MAX),
    verify_total: ledger.length,
    handoff: handoff === null ? null : handoff.slice(0, CYCLE_HANDOFF_MAX),
    handoff_truncated: handoff !== null && handoff.length > CYCLE_HANDOFF_MAX,
  }
}

/**
 * The roster's landed agents: which `cycle-NN/<agent>.json` files exist.
 *
 * This is the exact procedure `skills/mjloop-leader/SKILL.md:36-44` prescribes
 * for resuming, and it is the *only* real intra-cycle progress signal.
 * `StateSchema` permits stage `execute` and `judge`, but nothing in the engine
 * ever sets them — so a UI that promised a stage would be promising something
 * the engine never writes.
 */
export async function readRosterProgress(
  projectDir: string,
  runId: string,
  cycle: number,
): Promise<{ cycle: number; selected: string[]; landed: string[] } | null> {
  const dir = path.join(resolveLoopPaths(projectDir).runs, runId, `cycle-${String(cycle).padStart(2, '0')}`)
  const roster = await readJson(path.join(dir, 'roster.json'), RosterSchema)
  if (roster === null) return null
  const inside = await fs.readdir(dir).catch((): string[] => [])
  const landed = roster.selected.filter((agent) => inside.includes(`${agent}.json`))
  return { cycle, selected: roster.selected, landed }
}

/* ── memory ───────────────────────────────────────────────────────────────── */

export interface MemoryView {
  id: string
  kind: string
  title: string
  tags: string[]
  at: string
  run: string | null
  /** The plan and story this memory is scoped to, or null when it is project-wide. */
  plan: string | null
  story: string | null
  body: string
}

/**
 * The whole corpus, so the page can facet it.
 *
 * `memorySearch` supports no filter by kind, tag, time or originating run, so
 * faceting cannot be pushed to the server — and its `reason` is English prose
 * composed in the engine, which must not cross this wire.
 */
export async function readMemories(projectDir: string): Promise<MemoryView[]> {
  const memories = await listMemories(projectDir).catch(() => [])
  return memories.map((memory) => ({ ...memory.frontmatter, body: memory.body }))
}

export async function readMemoryEntry(projectDir: string, id: string): Promise<MemoryView> {
  try {
    const memory = await readMemory(projectDir, id)
    return { ...memory.frontmatter, body: memory.body }
  } catch {
    throw new NotFoundError('memory')
  }
}

/* ── the two cross-run reports ────────────────────────────────────────────── */

/**
 * Both are projections of `readRunHistory`, and both live in `ops/` because the
 * MCP server serves the same two reports from the same walk. They are re-stated
 * here rather than routed straight out of `api.ts` for two reasons the route
 * table should not have to carry: the bound each one puts on the wire, and the
 * translation of an engine exception into this file's `NotFoundError`.
 */

/**
 * The specialist table, bounded twice over.
 *
 * `readTelemetry` caps its rows at `TELEMETRY_MAX_ROWS` and reports `truncated`
 * beside them; the limit passed here is the other ceiling — how many run
 * directories the walk opens. It is the default made explicit, because the
 * number that matters is the one this wire is willing to pay for, and inheriting
 * it would let a later change to the op's default silently change what a browser
 * poll costs.
 *
 * This answer moves with `revisions.runs` and not the cycle tick, which is why a
 * cross-run walk at ~1.25 Hz is not what the Config tab does: `revisions.runs`
 * is the run-directory listing plus that directory's mtime, so it does not move
 * when a `cycle-NN/<agent>.json` lands inside a run that already exists. The
 * table goes stale during a live run and refreshes when the next run opens —
 * correct for a report whose subject is the last fifty runs.
 */
export async function readTelemetryReport(projectDir: string): Promise<Telemetry> {
  return await readTelemetry(projectDir, { limit: HISTORY_DEFAULT_LIMIT })
}

/**
 * The shape of a run the operator has not started yet.
 *
 * A pure read, and the pre-dispatch surface: `runStart` is permanently forbidden
 * from the browser, so the idle Run tab can show what a run would cost and
 * nothing here can begin one. No story is passed — the idle tab has none — and
 * that is not a default standing in for one: it selects ad-hoc runs as the
 * comparable set, which is what an operator about to type a goal is choosing
 * between.
 *
 * A track the project does not define, and a project with no config at all, are
 * both 404s rather than 500s: neither is this server failing to read something
 * it should have been able to read.
 */
export async function readPreflightEstimate(projectDir: string, track: string): Promise<Preflight> {
  try {
    return await preflightEstimate(projectDir, { track })
  } catch (error) {
    if (error instanceof UnknownTrackError) throw new NotFoundError('track')
    if (error instanceof ConfigMissingError) throw new NotFoundError('config')
    throw error
  }
}

/* ── roster validity ─────────────────────────────────────────────────────── */

/**
 * "Would this composition be accepted for this track" — `rosterValidity`
 * (`ops/roster.ts`), the dry-run half of `cycleRosterSet`'s own rules, wrapped
 * the same way `readPreflightEstimate` above wraps `preflightEstimate`: an
 * unknown track or a project with no config is a 404, not a 500, and neither
 * is this server failing to read something it should have.
 *
 * `rosterSet` itself is not on this file's import list and never will be —
 * `web/writes.ts` and `tests/web/boundary.test.ts`'s `FORBIDDEN` list refuse
 * it from every file under `src/web/`. This answers a question about a track;
 * it grants no way to make the answer come true.
 */
export async function readRosterValidity(
  projectDir: string,
  track: string,
  candidate: { selected: readonly string[]; skipped: Record<string, string> },
): Promise<RosterValidity> {
  try {
    return await rosterValidity(projectDir, { track, ...candidate })
  } catch (error) {
    if (error instanceof UnknownTrackError) throw new NotFoundError('track')
    if (error instanceof ConfigMissingError) throw new NotFoundError('config')
    throw error
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function readJson<T>(file: string, schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
    return parsed.success ? (parsed.data as T) : null
  } catch {
    return null
  }
}
