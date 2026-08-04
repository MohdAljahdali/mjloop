import { describe, expect, it } from 'vitest'
import { analyzeQualityRisk } from '../../src/ops/quality-risk.js'
import {
  ambiguousAcceptanceScenario,
  apiBoundaryScenario,
  authorizationScenario,
  backendScenario,
  buildConfigScenario,
  databaseDropAndAuthScenario,
  featureDeletionScenario,
  multipleComponentsScenario,
  repeatedFailureScenario,
  rtlScenario,
  schemaMigrationScenario,
} from '../fixtures/quality/scenarios.js'

describe('analyzeQualityRisk', () => {
  it.each([
    ['backend-only', backendScenario(), 'not_applicable'],
    ['rtl-component', rtlScenario(), 'required'],
  ] as const)('%s classifies UI applicability', (_name, input, expected) => {
    expect(analyzeQualityRisk(input).applicability.ui.value).toBe(expected)
  })

  it('raises database deletion and authorization changes to high risk', () => {
    const result = analyzeQualityRisk(databaseDropAndAuthScenario())

    expect(result.level).toBe('high')
    expect(result.signals.map((signal) => signal.code)).toEqual([
      'data.destructive',
      'data.schema',
      'security.authorization',
    ])
  })

  it.each([
    ['authorization paths', authorizationScenario(), 'security.authorization', 'high'],
    ['API paths', apiBoundaryScenario(), 'api.boundary', 'medium'],
    ['schema migrations', schemaMigrationScenario(), 'data.schema', 'medium'],
    ['feature deletion wording', featureDeletionScenario(), 'data.destructive', 'high'],
    ['build configuration', buildConfigScenario(), 'build.configuration', 'medium'],
    ['ambiguous acceptance', ambiguousAcceptanceScenario(), 'alignment.ambiguous', 'medium'],
    ['repeated prior failures', repeatedFailureScenario(), 'regression.repeated_failure', 'medium'],
  ] as const)('%s add the expected monotonic risk signal', (_name, input, code, level) => {
    const result = analyzeQualityRisk(input)

    expect(result.level).toBe(level)
    expect(result.signals.map((signal) => signal.code)).toContain(code)
  })

  it('deduplicates UI signals while retaining normalized path evidence', () => {
    const result = analyzeQualityRisk(multipleComponentsScenario())
    const signal = result.signals.find((entry) => entry.code === 'ui.surface')

    expect(result.applicability.ui.value).toBe('required')
    expect(result.applicability.ui.reason).toContain('src/ui/project-card.tsx')
    expect(signal).toEqual({
      code: 'ui.surface',
      level: 'medium',
      evidence: ['src/ui/project-card.tsx', 'src/ui/project-form.scss'],
    })
  })

  it('is deterministic across duplicate and reordered matching inputs', () => {
    const input = databaseDropAndAuthScenario()
    const reordered = {
      ...input,
      changedFiles: [...input.changedFiles].reverse().map((file) => ` ./${file.replaceAll('/', '\\')} `),
      acceptance: [...input.acceptance, input.acceptance[0]!],
    }

    expect(analyzeQualityRisk(reordered)).toEqual(analyzeQualityRisk(input))
  })

  it('always requires the four universal quality dimensions with reasons', () => {
    const { applicability } = analyzeQualityRisk(backendScenario())

    expect(applicability).toMatchObject({
      correctness: { value: 'required', reason: expect.any(String) },
      security: { value: 'required', reason: expect.any(String) },
      alignment: { value: 'required', reason: expect.any(String) },
      regression: { value: 'required', reason: expect.any(String) },
    })
  })
})
