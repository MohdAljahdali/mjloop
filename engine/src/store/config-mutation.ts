import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import * as YAML from 'yaml'
import * as z from 'zod'
import { AgentNameSchema } from '../schemas/contract.js'
import { IdSchema } from '../schemas/state.js'
import { ConfigSchema, LEGACY_CONFIG_KEYS, SpecialistModeSchema, TrackSchema } from '../schemas/config.js'
import { writeTextAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'

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
  }
}
