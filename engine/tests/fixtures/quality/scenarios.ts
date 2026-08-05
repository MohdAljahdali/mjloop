import type { QualityRiskInput } from '../../../src/ops/quality-risk.js'

function scenario(overrides: Partial<QualityRiskInput> = {}): QualityRiskInput {
  return {
    track: 'build',
    goal: 'Update project behavior.',
    acceptance: ['The requested behavior works.'],
    intendedFiles: [],
    changedFiles: [],
    componentKinds: [],
    priorFailures: [],
    ...overrides,
  }
}

export function backendScenario(): QualityRiskInput {
  return scenario({
    goal: 'Add an internal project service.',
    intendedFiles: ['src/services/projects.ts'],
    componentKinds: ['service'],
  })
}

export function authorizationScenario(): QualityRiskInput {
  return scenario({ changedFiles: ['src/auth/permissions.ts'] })
}

export function apiBoundaryScenario(): QualityRiskInput {
  return scenario({ intendedFiles: ['src/api/projects.ts'] })
}

export function rtlScenario(): QualityRiskInput {
  return scenario({
    goal: 'Add a right-to-left project settings screen.',
    intendedFiles: ['lib/widgets/project_settings.dart'],
    componentKinds: ['rtl_form'],
  })
}

export function schemaMigrationScenario(): QualityRiskInput {
  return scenario({ changedFiles: ['database/migrations/20260804_add_projects.sql'] })
}

export function databaseDropAndAuthScenario(): QualityRiskInput {
  return scenario({
    goal: 'Delete the obsolete projects table.',
    acceptance: ['Only authorized administrators can delete projects.'],
    changedFiles: ['database/migrations/20260804_drop_projects.sql', 'src/auth/permissions.ts'],
  })
}

export function featureDeletionScenario(): QualityRiskInput {
  return scenario({ acceptance: ['Remove the archived project feature.'] })
}

export function buildConfigScenario(): QualityRiskInput {
  return scenario({ changedFiles: ['package.json'] })
}

export function multipleComponentsScenario(): QualityRiskInput {
  return scenario({
    changedFiles: ['src/ui/project-card.tsx', 'src/ui/project-card.tsx', 'src/ui/project-form.scss'],
    componentKinds: ['card', 'form'],
  })
}

export function ambiguousAcceptanceScenario(): QualityRiskInput {
  return scenario({ acceptance: ['Update the project workflow as appropriate.'] })
}

export function repeatedFailureScenario(): QualityRiskInput {
  return scenario({ priorFailures: ['pnpm test :: project create failed', ' pnpm test :: project create failed '] })
}

/* ── the same scenarios as a project a run can actually open ──────────────── */

/**
 * One scenario expressed as the project evidence a run resolves it from.
 *
 * A `QualityRiskInput` above is what the analyzer sees; this is where those
 * same words have to be written for a real run to see them. A run's own risk
 * input is resolved from its goal and its story — never from a literal handed
 * to `analyzeQualityRisk` — so the cross-mode suite states each scenario once,
 * here, and both halves read the same words.
 */
export interface QualityProjectScenario {
  title: string
  goal: string
  acceptance: string[]
  ui: boolean
}

/** Ordinary backend work with nothing to flag: no signal fires, so risk is low. */
export function lowRiskBackendScenario(): QualityProjectScenario {
  return {
    title: 'Add the project service',
    goal: backendScenario().goal,
    acceptance: ['The service returns the stored project list.'],
    ui: false,
  }
}

/** The medium-risk backend change the mode matrix is written against: ambiguous acceptance, no user-visible surface. */
export function mediumBackendScenario(): QualityProjectScenario {
  return {
    title: 'Update the project workflow',
    goal: backendScenario().goal,
    acceptance: ambiguousAcceptanceScenario().acceptance,
    ui: false,
  }
}

/** Destructive wording in both the goal and the acceptance criteria: high risk. */
export function highRiskScenario(): QualityProjectScenario {
  const risk = databaseDropAndAuthScenario()
  return { title: 'Drop the obsolete projects table', goal: risk.goal, acceptance: risk.acceptance, ui: false }
}

/** A user-visible surface, so the analyzer raises `ui` to required. */
export function uiSurfaceScenario(): QualityProjectScenario {
  return {
    title: 'Add the project settings screen',
    goal: rtlScenario().goal,
    acceptance: ['The settings screen mirrors correctly in right-to-left locales.'],
    ui: true,
  }
}
