/**
 * The type-only surface `app/` needs from the server's protocol modules.
 *
 * Everything here is `export type`, erased at compile time, so nothing in
 * `dist/` changes because this file exists. It exists so `app/` never has its
 * own copy of `Snapshot` or `Write` that can drift from the server's — see
 * `../../protocol.js` and `../../writes.js` for the real definitions.
 */
export type {
  Snapshot,
  PlanView,
  StoryView,
  AgentView,
  AgentsView,
  Job,
  JobStatus,
  SessionView,
  GuardView,
  RosterView,
  Message,
  ServerMessage,
  ClientMessage,
} from '../../protocol.js'
export type { Write } from '../../writes.js'
export type { WebCode } from '../../codes.js'
export type { Revisions } from '../../revision.js'
export type { StateSummary } from '../../../ops/summary.js'
export type {
  StateView,
  RunDetail,
  ConfigView,
  PlanDetail,
  StoryDetail,
  RunSummary,
  CycleDetail,
  MemoryView,
  SkillsView,
  AcceptanceView,
  ProfileView,
  FeatureDetail,
  FeatureRevisionView,
} from '../../read.js'
export type { FeatureSummary } from '../../../store/feature-store.js'
export type { FeatureBrief, Decision } from '../../../schemas/feature.js'
export type { Preflight } from '../../../ops/preflight.js'
export type { SkillManifest, SkillSelection } from '../../../schemas/skill-selection.js'
export type { ProjectSkillAcceptance } from '../../../schemas/skill-acceptance.js'
export type { Finding, HistoryEntry } from '../../../schemas/state.js'
export type { LedgerEntry } from '../../../schemas/verify.js'
export type { AgentResult, Evidence } from '../../../schemas/contract.js'
export type { ProjectComponent } from '../../../schemas/project-profile.js'
export type { SkillPackage } from '../../../schemas/skill-library.js'
export type { ProjectSkillOnDisk, UnreadableProjectSkill } from '../../../schemas/project-skills.js'
export type { SkillCandidate } from '../../../schemas/skill-import.js'
export type { UnreadablePackage } from '../../../store/skill-library-store.js'
export type { Config, Track } from '../../../schemas/config.js'
export type { ConfigChange } from '../../../store/config-mutation.js'
export type { Telemetry, SpecialistRow } from '../../../ops/telemetry.js'
