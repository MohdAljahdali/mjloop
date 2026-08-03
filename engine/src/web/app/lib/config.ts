/**
 * Config — the pure half of the panel: the plain-field diff, the structured
 * `specialists:`/`tracks:` draft rules, and the client-side mirrors of
 * `TrackSchema.superRefine`'s own checks.
 *
 * Ported from `public/panels/config.js`. The DOM seam that file needed —
 * hidden `specialists_json`/`tracks_json` fields feeding `collectConfigChanges`
 * — does not exist here: `Config.vue`'s draft is already the object this
 * module reads, so `collectConfigChanges` below takes it directly rather than
 * parsing it back out of a form. Everything else — the change vocabulary, the
 * four order-graph refusals, the change-impact preview (C6), the YAML comment
 * count — is the same walk over the same shapes, DOM-free so it is testable
 * under this suite's `environment: 'node'`.
 *
 * The invariant this file exists to protect: nothing here ever calls
 * `submit()`. It only ever turns state into the closed change vocabulary the
 * server accepts, or into a reason a control should be disabled. `Config.vue`
 * is the one and only caller of `submit()`, and it calls
 * `collectConfigChanges` immediately before doing so — see its own comment.
 */
import type { Config, ConfigChange, Track } from '../types/protocol.js'

/**
 * The two structured maps, as a user is editing them — a deep copy out of the
 * baseline, held apart from it so `collectConfigChanges` can diff the two
 * without an alias making every diff empty.
 */
export interface Draft {
  specialists: Record<string, string>
  tracks: Record<string, Track>
}

/** Every plain control on the form, named the way the wire names its own leaf. */
export interface ConfigFormValues {
  autonomous: boolean
  verifyCache: boolean
  maxParallelAgents: number
  noProgressStrikes: number
  planApproval: 'human' | 'auto'
  commit: 'human' | 'auto'
  preflight: 'human' | 'auto'
  verifyTest: string
  verifyLint: string
  verifyBuild: string
  timeoutMs: number
  lockTimeoutMs: number
  patternsTest: string
  patternsLint: string
  patternsBuild: string
  orchProfileAutoAccept: boolean
  orchDiscoveryMode: 'off' | 'ask' | 'always'
  orchDiscoveryQuestionBudget: number
  orchDiscoveryCompletion: 'auto-plan' | 'review' | 'save-only'
  orchExecutionAfterPlanApproval: 'manual' | 'auto'
  orchExecutionUncertainConcurrency: 'sequential' | 'ask' | 'parallel'
  orchExecutionRepairAttempts: number
  orchQualityIndependentPlanReview: boolean
  orchQualityIndependentVerification: boolean
  orchSkillsSourceGithub: boolean
  orchSkillsSourceRegistry: boolean
  orchSkillsSourceWeb: boolean
  /** The textarea's raw text, one registry per line — split and trimmed on read, exactly as `patterns()` below does. */
  orchSkillsTrustedRegistries: string
  orchSkillsUpdateMode: 'review' | 'auto' | 'pinned'
}

/** `VERIFY_COMMANDS` — the slots that are commands, named rather than derived; see `config.js`'s own comment. */
export const VERIFY_COMMANDS = ['test', 'lint', 'build'] as const

/** `orchestration.skills.sources`, in `SkillSourceSchema`'s own order. */
export const SKILL_SOURCES = ['github', 'registry', 'web'] as const

/** The two `orchestration.quality` leaves, which share a type and a change kind. */
export const QUALITY_KEYS = ['independent_plan_review', 'independent_verification'] as const

/** The label above each of a track's four agent lists. */
export const LIST_LABEL: Record<'required' | 'available' | 'closing' | 'blocks', string> = {
  required: 'config.required',
  available: 'config.available',
  closing: 'config.closing',
  blocks: 'config.gateBlocks',
}

/** Names the cycle directory keeps for itself — `contract.ts:23`. */
export const RESERVED_AGENTS = ['findings', 'roster', 'verify', 'evidence', 'handoff', 'map']

/** `IdSchema` and `AgentNameSchema` share this pattern; both reject the rest. */
export const NAME = /^[A-Za-z0-9_-]+$/

/** `AgentNameSchema` in the browser: the pattern, the `--` rule and the reserved list. Mirrored, never authoritative. */
export function validAgent(name: string): boolean {
  return NAME.test(name) && !name.includes('--') && !RESERVED_AGENTS.includes(name)
}

/** The form as `config.yaml`'s own parsed defaults would seed it. */
export function seedFormValues(config: Config): ConfigFormValues {
  return {
    autonomous: config.autonomous,
    verifyCache: config.verify_cache,
    maxParallelAgents: config.limits.max_parallel_agents,
    noProgressStrikes: config.limits.no_progress_strikes,
    planApproval: config.gates.plan_approval,
    commit: config.gates.commit,
    preflight: config.gates.preflight,
    verifyTest: config.verify.test ?? '',
    verifyLint: config.verify.lint ?? '',
    verifyBuild: config.verify.build ?? '',
    timeoutMs: config.verify.timeout_ms,
    lockTimeoutMs: config.verify.lock_timeout_ms,
    patternsTest: config.verify.failure_patterns.test.join('\n'),
    patternsLint: config.verify.failure_patterns.lint.join('\n'),
    patternsBuild: config.verify.failure_patterns.build.join('\n'),
    orchProfileAutoAccept: config.orchestration.profile.auto_accept,
    orchDiscoveryMode: config.orchestration.discovery.mode,
    orchDiscoveryQuestionBudget: config.orchestration.discovery.question_budget,
    orchDiscoveryCompletion: config.orchestration.discovery.completion,
    orchExecutionAfterPlanApproval: config.orchestration.execution.after_plan_approval,
    orchExecutionUncertainConcurrency: config.orchestration.execution.uncertain_concurrency,
    orchExecutionRepairAttempts: config.orchestration.execution.repair_attempts,
    orchQualityIndependentPlanReview: config.orchestration.quality.independent_plan_review,
    orchQualityIndependentVerification: config.orchestration.quality.independent_verification,
    orchSkillsSourceGithub: config.orchestration.skills.sources.includes('github'),
    orchSkillsSourceRegistry: config.orchestration.skills.sources.includes('registry'),
    orchSkillsSourceWeb: config.orchestration.skills.sources.includes('web'),
    orchSkillsTrustedRegistries: config.orchestration.skills.trusted_registries.join('\n'),
    orchSkillsUpdateMode: config.orchestration.skills.update_mode,
  }
}

/** The structured draft, deep-copied out of the baseline and never shared with it. */
export function seedDraft(config: Config): Draft {
  return JSON.parse(JSON.stringify({ specialists: config.specialists, tracks: config.tracks })) as Draft
}

/** @param name */
function patterns(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function command(value: string): string | null {
  return value.trim() || null
}

function push(changes: ConfigChange[], changed: boolean, change: ConfigChange): void {
  if (changed) changes.push(change)
}

/**
 * Turn the form and the draft into the same closed change vocabulary the
 * server accepts. Pure: reads `form`, `draft` and `baseline` and nothing
 * else, and never calls `submit()` — see this module's own header.
 */
export function collectConfigChanges(form: ConfigFormValues, draft: Draft, baseline: Config): ConfigChange[] {
  const changes: ConfigChange[] = []

  push(changes, baseline.autonomous !== form.autonomous, { kind: 'root', key: 'autonomous', value: form.autonomous })
  push(changes, baseline.verify_cache !== form.verifyCache, {
    kind: 'root',
    key: 'verify_cache',
    value: form.verifyCache,
  })
  push(changes, baseline.limits.max_parallel_agents !== form.maxParallelAgents, {
    kind: 'limit',
    key: 'max_parallel_agents',
    value: form.maxParallelAgents,
  })
  push(changes, baseline.limits.no_progress_strikes !== form.noProgressStrikes, {
    kind: 'limit',
    key: 'no_progress_strikes',
    value: form.noProgressStrikes,
  })

  push(changes, baseline.gates.plan_approval !== form.planApproval, {
    kind: 'gate',
    key: 'plan_approval',
    value: form.planApproval,
  })
  push(changes, baseline.gates.commit !== form.commit, { kind: 'gate', key: 'commit', value: form.commit })
  push(changes, baseline.gates.preflight !== form.preflight, {
    kind: 'gate',
    key: 'preflight',
    value: form.preflight,
  })

  push(changes, baseline.verify.test !== command(form.verifyTest), {
    kind: 'verify.command',
    key: 'test',
    value: command(form.verifyTest),
  })
  push(changes, baseline.verify.lint !== command(form.verifyLint), {
    kind: 'verify.command',
    key: 'lint',
    value: command(form.verifyLint),
  })
  push(changes, baseline.verify.build !== command(form.verifyBuild), {
    kind: 'verify.command',
    key: 'build',
    value: command(form.verifyBuild),
  })
  push(changes, baseline.verify.timeout_ms !== form.timeoutMs, {
    kind: 'verify.number',
    key: 'timeout_ms',
    value: form.timeoutMs,
  })
  push(changes, baseline.verify.lock_timeout_ms !== form.lockTimeoutMs, {
    kind: 'verify.number',
    key: 'lock_timeout_ms',
    value: form.lockTimeoutMs,
  })
  push(changes, JSON.stringify(baseline.verify.failure_patterns.test) !== JSON.stringify(patterns(form.patternsTest)), {
    kind: 'verify.patterns',
    key: 'test',
    value: patterns(form.patternsTest),
  })
  push(changes, JSON.stringify(baseline.verify.failure_patterns.lint) !== JSON.stringify(patterns(form.patternsLint)), {
    kind: 'verify.patterns',
    key: 'lint',
    value: patterns(form.patternsLint),
  })
  push(
    changes,
    JSON.stringify(baseline.verify.failure_patterns.build) !== JSON.stringify(patterns(form.patternsBuild)),
    { kind: 'verify.patterns', key: 'build', value: patterns(form.patternsBuild) },
  )

  const specialists = draft.specialists
  for (const agent of [...new Set([...Object.keys(baseline.specialists), ...Object.keys(specialists)])].sort()) {
    const next = agent in specialists ? specialists[agent] : null
    push(changes, baseline.specialists[agent] !== next, {
      kind: 'specialist',
      agent,
      value: next as 'auto' | 'always' | 'never' | null,
    })
  }

  // `order` rides through here with the rest of the track — see
  // `config.js`'s own comment on why a draft that moved only its order graph
  // is, from this loop's point of view, a track whose serialised JSON changed
  // like any other edit to the same object, and on the YAML-comment cost of
  // reusing this door (`trackCommentLoss` below is where that cost is shown).
  const tracks = draft.tracks
  for (const track of [...new Set([...Object.keys(baseline.tracks), ...Object.keys(tracks)])].sort()) {
    const next = track in tracks ? tracks[track] : null
    push(changes, JSON.stringify(baseline.tracks[track] ?? null) !== JSON.stringify(next ?? null), {
      kind: 'track',
      track,
      value: (next ?? null) as Config['tracks'][string] | null,
    })
  }

  const orchestration = baseline.orchestration
  push(changes, orchestration.profile.auto_accept !== form.orchProfileAutoAccept, {
    kind: 'orchestration.profile.auto_accept',
    value: form.orchProfileAutoAccept,
  })
  push(changes, orchestration.discovery.mode !== form.orchDiscoveryMode, {
    kind: 'orchestration.discovery.mode',
    value: form.orchDiscoveryMode,
  })
  push(changes, orchestration.discovery.question_budget !== form.orchDiscoveryQuestionBudget, {
    kind: 'orchestration.discovery.question_budget',
    value: form.orchDiscoveryQuestionBudget,
  })
  push(changes, orchestration.discovery.completion !== form.orchDiscoveryCompletion, {
    kind: 'orchestration.discovery.completion',
    value: form.orchDiscoveryCompletion,
  })
  push(changes, orchestration.execution.after_plan_approval !== form.orchExecutionAfterPlanApproval, {
    kind: 'orchestration.execution.after_plan_approval',
    value: form.orchExecutionAfterPlanApproval,
  })
  push(changes, orchestration.execution.uncertain_concurrency !== form.orchExecutionUncertainConcurrency, {
    kind: 'orchestration.execution.uncertain_concurrency',
    value: form.orchExecutionUncertainConcurrency,
  })
  push(changes, orchestration.execution.repair_attempts !== form.orchExecutionRepairAttempts, {
    kind: 'orchestration.execution.repair_attempts',
    value: form.orchExecutionRepairAttempts,
  })
  push(changes, orchestration.quality.independent_plan_review !== form.orchQualityIndependentPlanReview, {
    kind: 'orchestration.quality',
    key: 'independent_plan_review',
    value: form.orchQualityIndependentPlanReview,
  })
  push(changes, orchestration.quality.independent_verification !== form.orchQualityIndependentVerification, {
    kind: 'orchestration.quality',
    key: 'independent_verification',
    value: form.orchQualityIndependentVerification,
  })

  const sources = SKILL_SOURCES.filter(
    (source) =>
      (source === 'github' && form.orchSkillsSourceGithub) ||
      (source === 'registry' && form.orchSkillsSourceRegistry) ||
      (source === 'web' && form.orchSkillsSourceWeb),
  )
  // Compared as a set, never as a list — see `config.js`'s own comment: three
  // checkboxes cannot express an order, and a document that lists `[web,
  // github]` must not be rewritten into `[github, web]` merely by this panel
  // drawing it.
  push(changes, [...orchestration.skills.sources].sort().join(' ') !== [...sources].sort().join(' '), {
    kind: 'orchestration.skills.sources',
    value: [...sources],
  })
  const registries = patterns(form.orchSkillsTrustedRegistries)
  push(changes, JSON.stringify(orchestration.skills.trusted_registries) !== JSON.stringify(registries), {
    kind: 'orchestration.skills.trusted_registries',
    value: registries,
  })
  push(changes, orchestration.skills.update_mode !== form.orchSkillsUpdateMode, {
    kind: 'orchestration.skills.update_mode',
    value: form.orchSkillsUpdateMode,
  })

  return changes
}

/**
 * Why `ConfigSchema` would refuse this form as a whole document, or null.
 * Mirrored, never replacing — the server re-validates the whole document
 * under the project lock and stays the authority. See `config.js`'s own
 * comment for why these two pairs are worth catching here rather than only
 * at the server.
 */
export function orchestrationProblem(form: ConfigFormValues): string | null {
  if (form.orchDiscoveryCompletion === 'auto-plan' && form.orchDiscoveryMode === 'off') {
    return 'config.problem.autoPlanOff'
  }
  const registries = patterns(form.orchSkillsTrustedRegistries)
  if (form.orchSkillsSourceRegistry && registries.length === 0) return 'config.problem.registryUntrusted'
  if (registries.some((registry) => !registry.startsWith('https://'))) return 'config.problem.registryNotHttps'
  return null
}

/** Whether any track in the draft would fail `ConfigSchema`. */
export function broken(draft: Draft | null): boolean {
  if (draft === null) return false
  return Object.keys(draft.tracks).some((name) => trackProblems(draft, name).length > 0)
}

/**
 * Every agent name this project has already named, from the draft alone —
 * suggestions, never a closed list. See `config.js`'s own comment: the engine
 * deliberately never reads the agents directory.
 */
export function knownAgents(model: Draft): string[] {
  const names = new Set(Object.keys(model.specialists))
  for (const track of Object.values(model.tracks)) {
    for (const list of ['required', 'available', 'closing'] as const) {
      for (const agent of track[list] ?? []) names.add(agent)
    }
    if (track.gate !== undefined) {
      names.add(track.gate.proven_by)
      for (const agent of track.gate.blocks ?? []) names.add(agent)
    }
    if (track.map !== undefined) names.add(track.map.drafted_by)
  }
  names.delete('')
  return [...names].sort()
}

export interface TrackProblem {
  id: string
  key: string
  params: Record<string, string>
}

/**
 * Why the schema would reject this track, in the order a reader meets the
 * fields. Mirrored from `TrackSchema` and `ConfigSchema.superRefine` — see
 * `config.js`'s own comment for the exact line ranges each check answers to.
 */
export function trackProblems(model: Draft | null, name: string): TrackProblem[] {
  const track = model?.tracks[name]
  if (model === null || model === undefined || track === undefined) return []

  const problems: TrackProblem[] = []
  const seen = new Set<string>()
  const add = (key: string, agentName?: string, paramName?: string): void => {
    const id = agentName === undefined ? key : `${key}:${agentName}`
    if (seen.has(id)) return
    seen.add(id)
    problems.push({ id, key, params: agentName === undefined ? {} : { [paramName ?? 'agent']: agentName } })
  }

  const known = new Set([...track.required, ...(track.available ?? []), ...(track.closing ?? [])])
  const draftable = new Set([...track.required, ...(track.available ?? [])])
  const forbidden = new Set(
    Object.entries(model.specialists)
      .filter(([, mode]) => mode === 'never')
      .map(([agent]) => agent),
  )

  if (track.required.length === 0) add('config.problem.noRequired')

  if (track.gate !== undefined) {
    if (!known.has(track.gate.proven_by)) add('config.problem.gateUnknown', track.gate.proven_by)
    for (const agent of track.gate.blocks ?? []) {
      if (!known.has(agent)) add('config.problem.blockUnknown', agent)
    }
    if ((track.gate.blocks ?? []).includes(track.gate.proven_by)) {
      add('config.problem.gateSelfBlock', track.gate.proven_by)
    }
    if ((track.gate.blocks ?? []).length === 0) add('config.problem.noBlocks')
    if (forbidden.has(track.gate.proven_by)) add('config.problem.forbidden', track.gate.proven_by)
  }

  if (track.map !== undefined) {
    if (!draftable.has(track.map.drafted_by)) add('config.problem.mapUnknown', track.map.drafted_by)
    if (forbidden.has(track.map.drafted_by)) add('config.problem.forbidden', track.map.drafted_by)
  }

  for (const agent of [...track.required, ...(track.closing ?? [])]) {
    if (forbidden.has(agent)) add('config.problem.forbidden', agent)
  }

  const order = track.order ?? []
  for (const edge of order) {
    if (!known.has(edge.agent)) add('config.problem.orderAgentUnknown', edge.agent)
    else if (track.closing.includes(edge.agent)) add('config.problem.orderAgentClosing', edge.agent)
    for (const pred of edge.after ?? []) {
      if (!known.has(pred)) add('config.problem.orderPredUnknown', pred)
      else if (track.closing.includes(pred)) add('config.problem.orderPredClosing', pred)
    }
    if (
      track.gate !== undefined &&
      edge.agent === track.gate.proven_by &&
      (edge.after ?? []).some((pred) => (track.gate?.blocks ?? []).includes(pred))
    ) {
      add('config.problem.orderInvertsGate', edge.agent)
    }
  }
  const blocks: string[] = track.gate?.blocks ?? []
  const gateEdges =
    track.gate === undefined ? [] : blocks.map((agent) => ({ agent, after: [(track.gate as { proven_by: string }).proven_by] }))
  const cycle = findOrderCycle([...order, ...gateEdges])
  if (cycle !== null) add('config.problem.orderCycle', cycle.join(' → '), 'path')

  return problems
}

/** Every predecessor a track's order graph names for one agent, across every edge that names it. */
export function edgeAfter(order: { agent: string; after: string[] }[], agent: string): string[] {
  return [...new Set(order.filter((edge) => edge.agent === agent).flatMap((edge) => edge.after))]
}

/** The first cycle a track's order graph contains, as the path that closes it, or `null`. A client-side mirror of `findOrderCycle` (`schemas/config.ts`). */
export function findOrderCycle(order: { agent: string; after: string[] }[]): string[] | null {
  const successors = new Map<string, string[]>()
  const nodes = new Set<string>()
  for (const edge of order) {
    nodes.add(edge.agent)
    for (const pred of edge.after) {
      nodes.add(pred)
      const list = successors.get(pred) ?? []
      list.push(edge.agent)
      successors.set(pred, list)
    }
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const path: string[] = []

  function visit(node: string): string[] | null {
    color.set(node, GRAY)
    path.push(node)
    for (const next of successors.get(node) ?? []) {
      const state = color.get(next) ?? WHITE
      if (state === GRAY) {
        const start = path.indexOf(next)
        return [...path.slice(start), next]
      }
      if (state === WHITE) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    color.set(node, BLACK)
    path.pop()
    return null
  }

  for (const node of nodes) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node)
      if (found !== null) return found
    }
  }
  return null
}

/* ── C6: change-impact preview ───────────────────────────────────────────── */

export interface PreviewItem {
  id: string
  key: string
  params: Record<string, string>
}

function previewField(name: string): PreviewItem {
  return { id: `field:${name}`, key: 'config.preview.fieldChanged', params: { field: name } }
}

/**
 * Which of a track's own fields (everything but `order`) would come out of
 * Save different from the baseline. `undefined` means the track is new this
 * session and has nothing of its own for Save to discard.
 */
export function trackFieldChanges(
  baselineTrack: Partial<Track> | undefined,
  draftTrack: Track,
): PreviewItem[] {
  if (baselineTrack === undefined) return [{ id: 'new', key: 'config.preview.newTrack', params: {} }]
  const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)
  const changes: PreviewItem[] = []
  if (differs(baselineTrack.required ?? [], draftTrack.required)) changes.push(previewField('required'))
  if (differs(baselineTrack.available ?? [], draftTrack.available ?? [])) changes.push(previewField('available'))
  if (differs(baselineTrack.closing ?? [], draftTrack.closing ?? [])) changes.push(previewField('closing'))
  if (baselineTrack.max_cycles !== draftTrack.max_cycles) changes.push(previewField('max_cycles'))
  if (differs(baselineTrack.gate ?? null, draftTrack.gate ?? null)) changes.push(previewField('gate'))
  if (differs(baselineTrack.map ?? null, draftTrack.map ?? null)) changes.push(previewField('map'))
  return changes
}

/** Every `{agent, pred}` pair a track's order graph names, flattened across every edge. */
export function flattenOrder(order: { agent: string; after: string[] }[]): { agent: string; pred: string }[] {
  return order.flatMap((edge) => (edge.after ?? []).map((pred) => ({ agent: edge.agent, pred })))
}

/** The order edges Save would add and remove, named by agent and predecessor. */
export function orderEdgeChanges(
  baselineTrack: { order?: { agent: string; after: string[] }[] },
  draftTrack: { order?: { agent: string; after: string[] }[] },
): PreviewItem[] {
  const before = flattenOrder(baselineTrack.order ?? [])
  const after = flattenOrder(draftTrack.order ?? [])
  const pairKey = (pair: { agent: string; pred: string }): string => `${pair.agent}:${pair.pred}`
  const beforeKeys = new Set(before.map(pairKey))
  const afterKeys = new Set(after.map(pairKey))
  const added = after.filter((pair) => !beforeKeys.has(pairKey(pair)))
  const removed = before.filter((pair) => !afterKeys.has(pairKey(pair)))
  return [
    ...added.map((pair) => ({ id: `add:${pairKey(pair)}`, key: 'config.preview.orderAdded', params: pair })),
    ...removed.map((pair) => ({ id: `remove:${pairKey(pair)}`, key: 'config.preview.orderRemoved', params: pair })),
  ]
}

/** Whether Save on this track would actually send anything — the whole-object compare `collectConfigChanges` itself uses, not `items.length` (see its own caller for why the two are not equivalent). */
export function trackPending(baselineTrack: Track | undefined, draftTrack: Track): boolean {
  return JSON.stringify(baselineTrack ?? null) !== JSON.stringify(draftTrack)
}

/**
 * How many whole-line comments live inside one track's own block in
 * `config.yaml`'s raw text, or `null` when that block cannot be located
 * reliably. Ported verbatim from `config.js`'s own `trackCommentLoss` — see
 * its comment for the full reasoning on why this undercounts rather than
 * risks inventing a number.
 */
export function trackCommentLoss(raw: string | null, track: string): number | null {
  if (raw === null) return null
  const lines = raw.split('\n')
  const indentOf = (line: string): number => line.length - line.trimStart().length

  const tracksAt = lines.findIndex((line) => /^tracks:\s*(#.*)?$/.test(line))
  if (tracksAt < 0) return null

  let bodyStart = -1
  let indent = -1
  for (let i = tracksAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const width = indentOf(line)
    if (width === 0) break
    bodyStart = i
    indent = width
    break
  }
  if (bodyStart < 0) return null

  const escaped = track.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const header = new RegExp(`^ {${indent}}${escaped}:(\\s|$)`)
  let headerAt = -1
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const width = indentOf(line)
    if (width < indent) break
    if (width === indent && header.test(line)) {
      headerAt = i
      break
    }
  }
  if (headerAt < 0) return null

  let count = 0
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const width = indentOf(line)
    if (width <= indent) break
    if (line.trim().startsWith('#')) count++
  }
  return count
}

/** `commandRows`/`policyRows` — the `verify:` block split into "commands run" and "everything else". */
export function commandRows(verify: Config['verify']): { key: string; value: string | null }[] {
  return VERIFY_COMMANDS.map((slot) => ({ key: `verify.${slot}`, value: verify[slot] }))
}

export function policyRows(verify: Config['verify']): { key: string; value: string | null }[] {
  const rows: { key: string; value: string | null }[] = [
    { key: 'verify.timeout_ms', value: String(verify.timeout_ms) },
    { key: 'verify.lock_timeout_ms', value: String(verify.lock_timeout_ms) },
  ]
  for (const slot of VERIFY_COMMANDS) {
    const values = verify.failure_patterns[slot]
    if (values.length > 0) rows.push({ key: `verify.failure_patterns.${slot}`, value: values.join('  ') })
  }
  return rows
}
