/**
 * Queue — a second view inside the terminal pane, one click away.
 *
 * Three groups rather than one reversed stream. "What is running", "what is
 * waiting" and "what already happened" are three different questions, and a
 * single list answers them by making the reader compare status words down a
 * column. Ported from `panels/queue.js`'s `split`, DOM-free and unchanged in
 * meaning: `QueueView.vue` is the only caller.
 */
import type { Job } from '../types/protocol.js'

/** Which group a job belongs in. */
export const RUNNING = 'running'
export const WAITING = 'waiting'
export const HISTORY = 'history'

/**
 * Split the queue the way the panel reads it.
 *
 * History is newest first — the last thing that happened is the thing being
 * looked for. Waiting keeps the order it will actually run in, which is the
 * whole point of showing a position next to it.
 */
export function split(jobs: readonly Job[]): { running: Job[]; waiting: Job[]; history: Job[] } {
  return {
    running: jobs.filter((job) => job.status === 'running'),
    waiting: jobs.filter((job) => job.status === 'queued'),
    history: jobs
      .filter((job) => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
      .slice()
      .reverse(),
  }
}
