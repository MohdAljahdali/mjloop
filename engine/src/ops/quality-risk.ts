import type { QualityDimension, RiskLevel } from '../schemas/quality.js'

export interface QualityRiskInput {
  track: string
  goal: string
  acceptance: string[]
  intendedFiles: string[]
  changedFiles: string[]
  componentKinds: string[]
  priorFailures: string[]
}

export interface QualityAnalysis {
  level: RiskLevel
  signals: { code: string; level: RiskLevel; evidence: string[] }[]
  applicability: Record<QualityDimension, { value: 'required' | 'not_applicable'; reason: string }>
}

interface SignalRule {
  code: string
  level: RiskLevel
  path: RegExp
}

const SIGNALS: readonly SignalRule[] = [
  { code: 'security.authorization', level: 'high', path: /(^|\/)(auth|permissions?|polic(?:y|ies))(\/|\.|$)/i },
  { code: 'data.schema', level: 'medium', path: /(^|\/)(migrations?|schema|database)(\/|\.|$)/i },
  { code: 'ui.surface', level: 'medium', path: /\.(vue|tsx|jsx|css|scss|dart)$/i },
  { code: 'build.configuration', level: 'medium', path: /(^|\/)(package\.json|tsconfig.*\.json|vite\.config\.)/i },
]

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
const API_BOUNDARY_PATH = /(^|\/)(api|routes?|controllers?)(\/|\.|$)/i
const DESTRUCTIVE_WORDING = /\b(delete|deletion|remove|removal|drop|truncate|purge)\b/i
const AMBIGUOUS_ACCEPTANCE = /\b(as appropriate|as needed|tbd|todo|etc\.?)\b/i
const USER_VISIBLE_WORDING = /\b(ui|user interface|screen|page|view|dashboard|form|button|layout|rtl|right[- ]to[- ]left|display|visible)\b/i
const USER_VISIBLE_COMPONENT = /(^|[\s_-])(ui|view|page|screen|widget|form|modal|dialog|layout|card|rtl)([\s_-]|$)/i

/**
 * Classifies only the supplied, normalized feature inputs. It is deliberately
 * synchronous and has no ambient inputs so a pinned quality policy can be
 * recreated without filesystem, model, or subprocess state.
 */
export function analyzeQualityRisk(input: QualityRiskInput): QualityAnalysis {
  const paths = distinct(input.intendedFiles.concat(input.changedFiles), normalizePath)
  const acceptance = distinct(input.acceptance, normalizeText)
  const goal = normalizeText(input.goal)
  const text = distinct([goal].concat(acceptance), normalizeText)
  const components = distinct(input.componentKinds, normalizeText)
  const signals = new Map<string, { code: string; level: RiskLevel; evidence: string[] }>()

  for (const rule of SIGNALS) {
    addSignal(signals, rule.code, rule.level, paths.filter((path) => rule.path.test(path)))
  }
  addSignal(signals, 'api.boundary', 'medium', paths.filter((path) => API_BOUNDARY_PATH.test(path)))
  addSignal(signals, 'data.destructive', 'high', text.filter((value) => DESTRUCTIVE_WORDING.test(value)))
  addSignal(signals, 'alignment.ambiguous', 'medium', acceptance.filter((value) => AMBIGUOUS_ACCEPTANCE.test(value)))
  addSignal(signals, 'regression.repeated_failure', 'medium', repeatedValues(input.priorFailures))

  const uiEvidence = distinct(
    paths.filter((path) => SIGNALS[2]!.path.test(path))
      .concat(components.filter((component) => USER_VISIBLE_COMPONENT.test(component)))
      .concat(text.filter((value) => USER_VISIBLE_WORDING.test(value))),
    normalizeText,
  )

  const orderedSignals = [...signals.values()]
    .map((signal) => ({ ...signal, evidence: distinct(signal.evidence, normalizeText) }))
    .sort((left, right) => left.code.localeCompare(right.code))
  const highestRank = Math.max(RANK.low, ...orderedSignals.map((signal) => RANK[signal.level]))
  const level: RiskLevel = highestRank === RANK.high ? 'high' : highestRank === RANK.medium ? 'medium' : 'low'

  return {
    level,
    signals: orderedSignals,
    applicability: {
      correctness: { value: 'required', reason: 'Every change requires correctness verification.' },
      security: { value: 'required', reason: 'Every change requires security review.' },
      alignment: { value: 'required', reason: 'Every change requires acceptance alignment.' },
      regression: { value: 'required', reason: 'Every change requires regression coverage.' },
      ui: uiEvidence.length > 0
        ? { value: 'required', reason: `User-visible surface indicated by: ${uiEvidence.join(', ')}.` }
        : { value: 'not_applicable', reason: 'No path, component, goal, or acceptance signal indicates a user-visible surface.' },
    },
  }
}

function addSignal(
  signals: Map<string, { code: string; level: RiskLevel; evidence: string[] }>,
  code: string,
  level: RiskLevel,
  evidence: string[],
): void {
  if (evidence.length === 0) return
  const existing = signals.get(code)
  if (existing === undefined) {
    signals.set(code, { code, level, evidence: distinct(evidence, normalizeText) })
    return
  }
  existing.evidence = distinct(existing.evidence.concat(evidence), normalizeText)
}

function repeatedValues(values: string[]): string[] {
  const seen = new Map<string, { value: string; count: number }>()
  for (const raw of values) {
    const value = normalizeText(raw)
    if (value.length === 0) continue
    const key = value.toLocaleLowerCase()
    const prior = seen.get(key)
    if (prior === undefined) seen.set(key, { value, count: 1 })
    else {
      prior.count += 1
      if (value.localeCompare(prior.value) < 0) prior.value = value
    }
  }
  return [...seen.values()].filter((entry) => entry.count > 1).map((entry) => entry.value).sort((a, b) => a.localeCompare(b))
}

function distinct(values: string[], normalize: (value: string) => string): string[] {
  const byKey = new Map<string, string>()
  for (const raw of values) {
    const value = normalize(raw)
    if (value.length === 0) continue
    const key = value.toLocaleLowerCase()
    const prior = byKey.get(key)
    if (prior === undefined || value.localeCompare(prior) < 0) byKey.set(key, value)
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right))
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}
