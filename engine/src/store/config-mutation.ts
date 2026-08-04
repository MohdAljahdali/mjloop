import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import * as YAML from 'yaml'
import * as z from 'zod'
import { AgentNameSchema } from '../schemas/contract.js'
import { IdSchema } from '../schemas/state.js'
import {
  AfterPlanApprovalSchema,
  ConfigSchema,
  DiscoveryCompletionSchema,
  FeatureDiscoveryModeSchema,
  LEGACY_CONFIG_KEYS,
  QualityModeSchema,
  SkillSourceSchema,
  SkillUpdateModeSchema,
  SpecialistModeSchema,
  TrackSchema,
  UncertainConcurrencySchema,
} from '../schemas/config.js'
import { writeTextAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'
import { StateStore } from './state-store.js'
import { ensureRunQualityPolicy } from '../ops/quality-policy.js'

const VerifySlotSchema = z.enum(['test', 'lint', 'build'])

export const ConfigChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('root'),
    key: z.enum(['autonomous', 'verify_cache']),
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('limit'),
    key: z.enum(['max_parallel_agents', 'no_progress_strikes']),
    value: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('verify.command'),
    key: VerifySlotSchema,
    value: z.string().min(1).nullable(),
  }),
  z.strictObject({
    kind: z.literal('verify.number'),
    key: z.enum(['timeout_ms', 'lock_timeout_ms']),
    value: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('verify.patterns'),
    key: VerifySlotSchema,
    value: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal('gate'),
    key: z.enum(['plan_approval', 'commit', 'preflight']),
    value: z.enum(['human', 'auto']),
  }),
  z.strictObject({
    kind: z.literal('specialist'),
    agent: AgentNameSchema,
    value: SpecialistModeSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('track'),
    track: IdSchema,
    value: TrackSchema.nullable(),
  }),
  // One variant per orchestration leaf, rather than one `orchestration` kind
  // carrying a section and a key. The discriminant is what makes each value
  // schema exact — a single kind would have to widen `value` to the union of
  // every leaf's type, and a boolean would then be accepted for
  // `question_budget` at the wire and only caught by the post-apply re-parse.
  // Restating the bounds here is deliberate duplication: this is the door the
  // browser and the CLI push values through, and it must be exactly as strict
  // as the schema those values are finally validated against.
  z.strictObject({
    kind: z.literal('orchestration.profile.auto_accept'),
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('orchestration.discovery.mode'),
    value: FeatureDiscoveryModeSchema,
  }),
  z.strictObject({
    kind: z.literal('orchestration.discovery.question_budget'),
    value: z.number().int().min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('orchestration.discovery.completion'),
    value: DiscoveryCompletionSchema,
  }),
  z.strictObject({
    kind: z.literal('orchestration.execution.after_plan_approval'),
    value: AfterPlanApprovalSchema,
  }),
  z.strictObject({
    kind: z.literal('orchestration.execution.uncertain_concurrency'),
    value: UncertainConcurrencySchema,
  }),
  z.strictObject({
    kind: z.literal('orchestration.execution.repair_attempts'),
    value: z.number().int().min(0).max(5),
  }),
  z.strictObject({
    kind: z.literal('orchestration.quality.mode'),
    value: QualityModeSchema,
  }),
  z.strictObject({
    kind: z.literal('orchestration.skills.sources'),
    value: z.array(SkillSourceSchema),
  }),
  z.strictObject({
    kind: z.literal('orchestration.skills.trusted_registries'),
    value: z.array(z.string().min(1).startsWith('https://', 'a trusted registry must be an https:// URL')),
  }),
  z.strictObject({
    kind: z.literal('orchestration.skills.update_mode'),
    value: SkillUpdateModeSchema,
  }),
])

export const ConfigPatchSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(ConfigChangeSchema).min(1).max(100),
})

export type ConfigChange = z.infer<typeof ConfigChangeSchema>
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>
export type ConfigMutationFailure = 'stale' | 'invalid' | 'missing'

export class ConfigMutationError extends Error {
  readonly kind: ConfigMutationFailure
  readonly path: (string | number)[]

  constructor(kind: ConfigMutationFailure, path: (string | number)[] = []) {
    super(kind)
    this.name = 'ConfigMutationError'
    this.kind = kind
    this.path = path
  }
}

export function configRevision(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export async function mutateConfig(projectDir: string, patch: ConfigPatch): Promise<{ revision: string }> {
  const parsedPatch = ConfigPatchSchema.parse(patch)
  const paths = resolveLoopPaths(projectDir)

  // A run opened before quality pins existed must snapshot the old setting
  // before this guarded write moves it. Existing pinned runs are only
  // validated here; ensureRunQualityPolicy never rewrites their policy.
  if (parsedPatch.changes.some((change) => change.kind === 'orchestration.quality.mode')) {
    try {
      const state = await new StateStore(projectDir).get()
      const active = ['running', 'paused', 'waiting_for_user', 'budget_exhausted'].includes(state.status)
      if (state.run_id !== null && state.track !== null && active) {
        await ensureRunQualityPolicy(projectDir)
      }
    } catch (error) {
      try {
        await fs.access(paths.state)
      } catch {
        // Store-only tests and configuration preparation legitimately have no
        // state file yet. A project with a state file must not hide a corrupt
        // or incomplete policy behind a successful mode change.
        return mutateConfigWithoutBootstrap(projectDir, parsedPatch, paths)
      }
      throw error
    }
  }

  return mutateConfigWithoutBootstrap(projectDir, parsedPatch, paths)
}

async function mutateConfigWithoutBootstrap(
  projectDir: string,
  parsedPatch: ConfigPatch,
  paths: ReturnType<typeof resolveLoopPaths>,
): Promise<{ revision: string }> {
  return withLock(paths.lock, async () => {
    let raw: string
    try {
      raw = await fs.readFile(paths.config, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigMutationError('missing')
      throw error
    }

    if (configRevision(raw) !== parsedPatch.revision) throw new ConfigMutationError('stale')

    const document = YAML.parseDocument(raw, { keepSourceTokens: true })
    if (document.errors.length > 0) throw new ConfigMutationError('invalid')

    for (const change of parsedPatch.changes) applyChange(document, change)

    let candidate: unknown
    try {
      candidate = document.toJS()
    } catch {
      throw new ConfigMutationError('invalid')
    }
    const parsed = ConfigSchema.safeParse(stripLegacy(candidate))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const issuePath =
        issue?.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') ??
        []
      throw new ConfigMutationError('invalid', issuePath)
    }

    const next = document.toString({ lineWidth: 100 })
    await writeTextAtomic(paths.config, next)
    return { revision: configRevision(next) }
  })
}

function stripLegacy(document: unknown): unknown {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return document
  return Object.fromEntries(
    Object.entries(document as Record<string, unknown>).filter(
      ([key]) => !LEGACY_CONFIG_KEYS.includes(key as (typeof LEGACY_CONFIG_KEYS)[number]),
    ),
  )
}

function applyChange(document: YAML.Document, change: ConfigChange): void {
  switch (change.kind) {
    case 'root':
      document.setIn([change.key], change.value)
      return
    case 'limit':
      document.setIn(['limits', change.key], change.value)
      return
    case 'verify.command':
    case 'verify.number':
      document.setIn(['verify', change.key], change.value)
      return
    case 'verify.patterns':
      document.setIn(['verify', 'failure_patterns', change.key], change.value)
      return
    case 'gate':
      document.setIn(['gates', change.key], change.value)
      return
    case 'specialist':
      if (change.value === null) document.deleteIn(['specialists', change.agent])
      else document.setIn(['specialists', change.agent], change.value)
      return
    case 'track':
      if (change.value === null) document.deleteIn(['tracks', change.track])
      else document.setIn(['tracks', change.track], change.value)
      return
    // `setIn` builds the intermediate maps it needs, which is what lets the
    // very first orchestration setting land in a config.yaml written before
    // the block existed — the common case on every already-provisioned
    // project. Only the named leaf is written; every sibling arrives on read
    // from the schema's prefaults, so one changed setting never rewrites
    // twelve lines of somebody's hand-edited file.
    case 'orchestration.profile.auto_accept':
      document.setIn(['orchestration', 'profile', 'auto_accept'], change.value)
      return
    case 'orchestration.discovery.mode':
      document.setIn(['orchestration', 'discovery', 'mode'], change.value)
      return
    case 'orchestration.discovery.question_budget':
      document.setIn(['orchestration', 'discovery', 'question_budget'], change.value)
      return
    case 'orchestration.discovery.completion':
      document.setIn(['orchestration', 'discovery', 'completion'], change.value)
      return
    case 'orchestration.execution.after_plan_approval':
      document.setIn(['orchestration', 'execution', 'after_plan_approval'], change.value)
      return
    case 'orchestration.execution.uncertain_concurrency':
      document.setIn(['orchestration', 'execution', 'uncertain_concurrency'], change.value)
      return
    case 'orchestration.execution.repair_attempts':
      document.setIn(['orchestration', 'execution', 'repair_attempts'], change.value)
      return
    case 'orchestration.quality.mode':
      if (document.hasIn(['orchestration', 'quality', 'independent_plan_review'])) {
        document.deleteIn(['orchestration', 'quality', 'independent_plan_review'])
      }
      if (document.hasIn(['orchestration', 'quality', 'independent_verification'])) {
        document.deleteIn(['orchestration', 'quality', 'independent_verification'])
      }
      document.setIn(['orchestration', 'quality', 'mode'], change.value)
      return
    case 'orchestration.skills.sources':
      document.setIn(['orchestration', 'skills', 'sources'], change.value)
      return
    case 'orchestration.skills.trusted_registries':
      document.setIn(['orchestration', 'skills', 'trusted_registries'], change.value)
      return
    case 'orchestration.skills.update_mode':
      document.setIn(['orchestration', 'skills', 'update_mode'], change.value)
  }
}
