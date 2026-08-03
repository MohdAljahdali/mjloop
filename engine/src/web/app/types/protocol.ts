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
