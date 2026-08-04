import * as z from 'zod'
import { QualityModeSchema } from './config.js'
import { IdSchema } from './state.js'

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest')
const RunIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{3}$/, 'a run id looks like 2026-08-04-001')
const ProseSchema = z.string().trim().min(1).max(4_000)
const ReferenceSchema = z.string().trim().min(1).max(1_000)
const DecisionBySchema = z.string().trim().min(1).max(200)

function distinctStrings(values: string[], ctx: z.RefinementCtx, field: string): void {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: [field], message: `${field} must not contain duplicates` })
}

export const QualityDimensionSchema = z.enum(['correctness', 'security', 'alignment', 'regression', 'ui'])
export const QualityVerdictSchema = z.enum(['pending', 'pass', 'fail', 'blocked', 'not_applicable'])
/** Evidence vocabulary owned by the quality ledger, including downstream reviews. */
export const QualityEvidenceKindSchema = z.enum(['command', 'test', 'agent', 'human'])
export const SupervisionSchema = z.enum(['supervised', 'unattended'])
export const QualityEnforcementSchema = z.enum(['shadow', 'active'])
export const MeasurementKindSchema = z.enum(['measured', 'estimated', 'unavailable'])
export const RiskLevelSchema = z.enum(['low', 'medium', 'high'])
export const QualityRiskCodeSchema = z.enum([
  'alignment.ambiguous',
  'api.boundary',
  'build.configuration',
  'data.destructive',
  'data.schema',
  'regression.repeated_failure',
  'security.authorization',
  'ui.surface',
])
export const QualityApplicabilitySchema = z.enum(['required', 'not_applicable'])
export const QualityConfigSourceSchema = z.enum(['explicit', 'legacy'])
export const QualityBudgetFieldSchema = z.enum([
  'max_cycles',
  'max_dispatches',
  'max_context_tokens_per_dispatch',
  'max_repair_attempts',
])

const CostEstimateSchema = z
  .strictObject({
    model_id: z.string().trim().min(1).max(200),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    currency: z.string().trim().length(3),
    input_unit_price: z.number().nonnegative(),
    output_unit_price: z.number().nonnegative(),
    pricing_table_version: z.string().trim().min(1).max(200),
    total: z.number().nonnegative(),
  })

export const QualityBudgetSchema = z.strictObject({
  max_cycles: z.number().int().positive(),
  max_dispatches: z.number().int().positive(),
  max_context_tokens_per_dispatch: z.number().int().positive(),
  max_repair_attempts: z.number().int().nonnegative(),
  cost_estimate: CostEstimateSchema.nullable(),
})

export const QualityRiskSignalSchema = z.strictObject({
  code: QualityRiskCodeSchema,
  level: RiskLevelSchema,
  evidence: z.array(ReferenceSchema).max(100),
})

export const QualityRiskSchema = z.strictObject({
  level: RiskLevelSchema,
  signals: z.array(QualityRiskSignalSchema).max(100),
})

export const QualityDispatchSchema = z.strictObject({
  agent: IdSchema,
  instance: IdSchema.nullable(),
  dimensions: z.array(QualityDimensionSchema).min(1).max(5),
  reason: ProseSchema,
})

export const QualityApplicabilityRecordSchema = z.strictObject({
  value: QualityApplicabilitySchema,
  reason: ProseSchema,
})

const InitialQualityPlanSchema = z.strictObject({
  correctness: QualityApplicabilityRecordSchema,
  security: QualityApplicabilityRecordSchema,
  alignment: QualityApplicabilityRecordSchema,
  regression: QualityApplicabilityRecordSchema,
  ui: QualityApplicabilityRecordSchema,
})

export const QualityPolicySchema = z
  .strictObject({
    version: z.literal(1),
    pinned_at: z.iso.datetime(),
    mode: QualityModeSchema,
    supervision: SupervisionSchema,
    enforcement: QualityEnforcementSchema,
    source: QualityConfigSourceSchema,
    risk: QualityRiskSchema,
    budget: QualityBudgetSchema,
    initial_quality_plan: InitialQualityPlanSchema,
    dispatches: z.array(QualityDispatchSchema).max(100),
  })
  .superRefine((policy, ctx) => {
    if (policy.enforcement === 'active' && policy.source !== 'explicit') {
      ctx.addIssue({ code: 'custom', path: ['enforcement'], message: 'active enforcement requires an explicit quality mode' })
    }
  })

export const QualityLedgerEntrySchema = z
  .strictObject({
    applicability: QualityApplicabilitySchema,
    status: QualityVerdictSchema,
    required_evidence: z.array(QualityEvidenceKindSchema).max(4),
    evidence_refs: z.array(ReferenceSchema).max(100),
    reason: ProseSchema,
    inputs_fingerprint: SHA256_SCHEMA,
    /** The engine-sampled tree identity; null is cycle-scoped and never reusable. */
    worktree_digest: SHA256_SCHEMA.nullable(),
    /** Cycle that recorded the evidence, not an agent supplied claim. */
    recorded_cycle: z.number().int().positive().nullable(),
    checked_at: z.iso.datetime().nullable(),
    invalidated_at: z.iso.datetime().nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.applicability === 'required' && entry.status === 'not_applicable') {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'a required dimension cannot be not_applicable' })
    }
    if (entry.applicability === 'not_applicable' && entry.status !== 'not_applicable') {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'a non-applicable dimension must be not_applicable' })
    }
  })

export const QualityLedgerSchema = z.strictObject({
  version: z.literal(1),
  /** Advanced only by the engine's cycle transition seam. */
  cycle: z.number().int().positive(),
  dimensions: z.strictObject({
    correctness: QualityLedgerEntrySchema,
    security: QualityLedgerEntrySchema,
    alignment: QualityLedgerEntrySchema,
    regression: QualityLedgerEntrySchema,
    ui: QualityLedgerEntrySchema,
  }),
})

export const QualityAmendmentSchema = z
  .strictObject({
    version: z.literal(1),
    run: RunIdSchema,
    field: QualityBudgetFieldSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    reason: ProseSchema,
    decided_at: z.iso.datetime(),
    decided_by: DecisionBySchema,
  })
  .superRefine((amendment, ctx) => {
    if (amendment.to <= amendment.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'an amendment must increase its budget field' })
    }
  })

export const DestructiveDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  decided_at: z.iso.datetime(),
  decided_by: DecisionBySchema,
  note: ProseSchema.nullable(),
  used_at: z.iso.datetime().nullable(),
})

export const DestructiveRequestSchema = z
  .strictObject({
    version: z.literal(1),
    run: RunIdSchema,
    operation_fingerprint: SHA256_SCHEMA,
    kind: z.enum(['feature_delete', 'table_drop', 'table_truncate', 'bulk_data_delete', 'irreversible_migration', 'project_wide']),
    targets: z.array(ReferenceSchema).min(1).max(100),
    operation: ProseSchema,
    reason: ProseSchema,
    approval_impact: ProseSchema,
    rejection_impact: ProseSchema,
    rollback: ProseSchema.nullable(),
    completed_work: z.array(ReferenceSchema).max(100),
    evidence_refs: z.array(ReferenceSchema).max(100),
    requested_at: z.iso.datetime(),
    capability_hash: SHA256_SCHEMA,
    decision: DestructiveDecisionSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    distinctStrings(request.targets, ctx, 'targets')
    distinctStrings(request.completed_work, ctx, 'completed_work')
    distinctStrings(request.evidence_refs, ctx, 'evidence_refs')
  })

export type QualityDimension = z.infer<typeof QualityDimensionSchema>
export type QualityVerdict = z.infer<typeof QualityVerdictSchema>
export type QualityEvidenceKind = z.infer<typeof QualityEvidenceKindSchema>
export type Supervision = z.infer<typeof SupervisionSchema>
export type QualityEnforcement = z.infer<typeof QualityEnforcementSchema>
export type MeasurementKind = z.infer<typeof MeasurementKindSchema>
export type RiskLevel = z.infer<typeof RiskLevelSchema>
export type QualityRiskCode = z.infer<typeof QualityRiskCodeSchema>
export type QualityBudget = z.infer<typeof QualityBudgetSchema>
export type QualityDispatch = z.infer<typeof QualityDispatchSchema>
export type QualityPolicy = z.infer<typeof QualityPolicySchema>
export type QualityLedger = z.infer<typeof QualityLedgerSchema>
export type QualityAmendment = z.infer<typeof QualityAmendmentSchema>
export type DestructiveDecision = z.infer<typeof DestructiveDecisionSchema>
export type DestructiveRequest = z.infer<typeof DestructiveRequestSchema>
