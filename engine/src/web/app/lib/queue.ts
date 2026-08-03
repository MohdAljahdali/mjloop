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

/**
 * The job a story's own Attach control would attach to — the newest job the
 * queue holds for this story that has actually started, running or finished.
 * `panels/stories.js`'s `jobForStory`, ported.
 *
 * `Job.story` survives every status a job passes through, so more than one
 * entry in one session can name the same story: a `/mjloop:build` that failed
 * and a `/mjloop:fix` that followed it both would. `jobs` arrives
 * `[...finished, ...active, ...pending]`, oldest first within each group,
 * which makes the whole array a rough timeline — walking it from the end
 * therefore answers with whichever job is the newest action against this
 * story.
 *
 * `queued` is skipped deliberately: attaching to a job that has not started
 * sends `{type:'attach', jobId}` for an id the server's transcript map has no
 * entry for, which blanks whatever the reader was actually watching.
 */
export function jobForStory(jobs: readonly Job[], storyId: string): Job | null {
  return jobs.slice().reverse().find((job) => job.story === storyId && job.status !== 'queued') ?? null
}
