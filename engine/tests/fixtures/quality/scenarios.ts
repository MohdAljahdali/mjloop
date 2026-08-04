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
