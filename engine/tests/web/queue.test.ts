import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/web/protocol.js'
import { JobQueue, STALL_MS, TRANSCRIPT_DISK_KEEP, TRANSCRIPT_DISK_MAX_BYTES } from '../../src/web/queue.js'
import { fakeSessions, type FakeSessions } from '../helpers/fake-session.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'
import { running, summary } from '../helpers/summary.js'

function makeClock(start = 1_000_000) {
  let now = start
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms
    },
  }
}

let sessions: FakeSessions
let clock: ReturnType<typeof makeClock>
let notices: Message[]
let queue: JobQueue

beforeEach(() => {
  sessions = fakeSessions()
  clock = makeClock()
  notices = []
  queue = new JobQueue({
    cwd: '/project',
    spawn: sessions.factory,
    clock: clock.clock,
    onOutput: () => {},
    onChange: () => {},
    onNotice: (message) => notices.push(message),
  })
})

describe('job identity', () => {
  it('names a job uniquely across restarts, not merely within one', () => {
    // The counter resets to zero every boot, so `j1` used to name a different
    // job after every restart. Harmless while nothing outlived the process;
    // not harmless the moment a transcript is filed under it.
    const first = queue.enqueue('/mjloop:build P001-S01')
    expect(first.id).toBe('19700101T001640-1')

    const later = new JobQueue({
      cwd: '/project',
      spawn: fakeSessions().factory,
      clock: makeClock(2_000_000).clock,
      onOutput: () => {},
      onChange: () => {},
      onNotice: () => {},
    })
    expect(later.enqueue('/mjloop:build P001-S01').id).not.toBe(first.id)
    // Sortable, and filename-safe: it reaches a path in the transcript store.
    expect(first.id).toMatch(/^[0-9T]+-\d+$/)
  })

  it('carries the story a command is building, and null when there is none', () => {
    // Named rather than parsed back out of the command: a hand-typed line that
    // reads the same would match, and a `/mjloop:fix` on the same story would
    // not.
    expect(queue.enqueue('/mjloop:build P001-S01', 'P001-S01').story).toBe('P001-S01')
    expect(queue.enqueue('/mjloop:plan an idea').story).toBeNull()
    expect(queue.jobs().map((entry) => entry.story)).toEqual(['P001-S01', null])
  })
})

/** Drive a job all the way from enqueue to a closed session. */
function finishJob(): void {
  queue.observe(running())
  queue.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
  sessions.last().end(0)
}

describe('JobQueue', () => {
  it('starts the first job immediately, with the command and project it was given', () => {
    queue.enqueue('/mjloop:build P001-S01')
    expect(sessions.sessions).toHaveLength(1)
    expect(sessions.last().options.command).toBe('/mjloop:build P001-S01')
    expect(sessions.last().options.cwd).toBe('/project')
  })

  it('runs one job at a time', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    // Not a simplification: two loops against one project overwrite each
    // other's state.json.
    expect(sessions.sessions).toHaveLength(1)
    expect(queue.jobs().filter((job) => job.status === 'queued')).toHaveLength(1)
  })

  it('closes a finished run and starts the next job in a fresh session', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')

    queue.observe(running())
    expect(sessions.last().written).toEqual([])

    queue.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    expect(sessions.last().written).toEqual(['/exit\r'])

    sessions.last().end(0)
    expect(sessions.sessions).toHaveLength(2)
    expect(sessions.last().options.command).toBe('/mjloop:build P001-S02')

    const [first] = queue.jobs()
    expect(first?.status).toBe('done')
  })

  it('does not close a job before its run has started', () => {
    queue.enqueue('/mjloop:build P001-S01')
    // An idle state before the run begins is the session still booting, not a
    // run that ended.
    queue.observe(summary({ status: 'idle' }))
    queue.observe(summary({ status: 'idle' }))
    expect(sessions.last().written).toEqual([])
    expect(queue.jobs()[0]?.status).toBe('running')
  })

  it('escalates through the shutdown ladder when /exit is ignored', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    queue.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))

    clock.advance(10_000)
    queue.observe(summary({ status: 'done' }))
    expect(sessions.last().killed).toEqual(['SIGTERM'])

    clock.advance(3_000)
    queue.observe(summary({ status: 'done' }))
    expect(sessions.last().killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('abandons a session that survives SIGKILL rather than holding the queue', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())
    queue.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))

    clock.advance(10_000)
    queue.observe(summary({ status: 'done' }))
    clock.advance(3_000)
    queue.observe(summary({ status: 'done' }))
    clock.advance(3_000)
    queue.observe(summary({ status: 'done' }))

    expect(notices.map((notice) => notice.code)).toContain('job.abandoned')
    expect(sessions.sessions).toHaveLength(2)
  })

  it('fails the job and holds the queue when a session exits on its own', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())

    sessions.last().end(1)

    const [first] = queue.jobs()
    expect(first?.status).toBe('failed')
    expect(first?.reason).toEqual({ code: 'job.failed.exit', params: { code: 1 } })
    // A person who comes back to fifteen repetitions of one failure has been
    // given less than a person who comes back to one.
    expect(sessions.sessions).toHaveLength(1)
    expect(queue.session().blocked).toBe(true)
    expect(notices.map((notice) => notice.code)).toContain('queue.blocked')
  })

  it('treats a clean exit before the run finished as a failure too', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    sessions.last().end(0)
    expect(queue.jobs()[0]?.reason).toEqual({ code: 'job.failed.early' })
  })

  it('resumes a held queue', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())
    sessions.last().end(1)

    queue.resume()
    expect(sessions.sessions).toHaveLength(2)
    expect(sessions.last().options.command).toBe('/mjloop:build P001-S02')
  })

  it('removes a queued job without touching the running one', () => {
    queue.enqueue('/mjloop:build P001-S01')
    const second = queue.enqueue('/mjloop:build P001-S02')
    queue.cancel(second.id)

    expect(queue.jobs().find((job) => job.id === second.id)?.status).toBe('cancelled')
    expect(sessions.last().killed).toEqual([])
  })

  it('clears the queue but leaves the running job alone', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.clear()

    expect(queue.jobs().filter((job) => job.status === 'queued')).toHaveLength(0)
    expect(queue.session().jobId).not.toBeNull()
  })

  it('stops the running job and holds the queue', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())
    queue.stop()

    expect(sessions.last().written).toEqual(['/exit\r'])
    // Reported while the ladder runs, so the page can say "closing" instead of
    // showing a job as running behind a button that now does nothing.
    expect(queue.session().closing).toBe(true)
    sessions.last().end(0)

    expect(queue.jobs()[0]?.status).toBe('cancelled')
    expect(sessions.sessions).toHaveLength(1)
    expect(queue.session()).toMatchObject({ blocked: true, pausedBy: 'stopped', closing: false })
  })

  it('does not stay paused after a stop with nothing left to hold', () => {
    // The wedge this fixes: stopping the only job left the queue blocked with no
    // banner and no Resume button, so the next command the user typed sat at
    // `queued` forever and the page looked broken.
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    queue.stop()
    sessions.last().end(0)

    expect(queue.session().blocked).toBe(false)
    queue.enqueue('/mjloop:build P001-S02')
    expect(sessions.sessions).toHaveLength(2)
    expect(queue.jobs().at(-1)?.status).toBe('running')
  })

  it('does not pause after a failure with nothing left to hold, and says so differently', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    sessions.last().end(1)

    expect(queue.jobs()[0]?.status).toBe('failed')
    expect(queue.session().blocked).toBe(false)
    // "the rest of the queue is holding" would send the user looking for a queue
    // that is not there.
    expect(notices.map((notice) => notice.code)).toEqual(['queue.failed'])
  })

  it('ignores a second stop rather than restarting the shutdown ladder', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    queue.stop()
    clock.advance(9_000)
    queue.stop()

    // Re-arming would push SIGTERM out by another ten seconds, which makes Stop
    // slower the more often it is pressed.
    clock.advance(1_000)
    queue.observe(running())
    expect(sessions.last().killed).toEqual(['SIGTERM'])
    expect(sessions.last().written).toEqual(['/exit\r'])
  })

  it('stops the running job when its own row is cancelled', () => {
    // One `cancel` with a job id, whichever half of the queue that job is in:
    // the × on the running row used to do nothing at all.
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    const [live] = queue.jobs()
    queue.cancel(live?.id ?? '')

    expect(sessions.last().written).toEqual(['/exit\r'])
    sessions.last().end(0)
    expect(queue.jobs()[0]?.status).toBe('cancelled')
  })

  it('lifts the pause when the queue it was holding is cleared', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())
    sessions.last().end(1)
    expect(queue.session().blocked).toBe(true)

    queue.clear()
    expect(queue.session().blocked).toBe(false)
    queue.enqueue('/mjloop:build P001-S03')
    expect(sessions.last().options.command).toBe('/mjloop:build P001-S03')
  })

  it('reports a failure pause with the cause named', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.enqueue('/mjloop:build P001-S02')
    queue.observe(running())
    sessions.last().end(1)
    expect(queue.session()).toMatchObject({ blocked: true, pausedBy: 'failure' })

    queue.resume()
    expect(queue.session()).toMatchObject({ blocked: false, pausedBy: null })
  })

  it('reports a running session that has gone quiet', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    expect(queue.session().stalledSince).toBeNull()

    clock.advance(STALL_MS)
    queue.observe(running())
    expect(queue.session().stalledSince).not.toBeNull()

    // Output clears it: the session was busy after all.
    sessions.last().emit('thinking…')
    expect(queue.session().stalledSince).toBeNull()
  })

  it('never reports a stall before the run starts', () => {
    queue.enqueue('/mjloop:build P001-S01')
    clock.advance(STALL_MS * 4)
    queue.observe(summary({ status: 'idle' }))
    expect(queue.session().stalledSince).toBeNull()
  })

  it('keeps each job transcript', () => {
    queue.enqueue('/mjloop:build P001-S01')
    const job = queue.jobs()[0]
    sessions.last().emit('hello ')
    sessions.last().emit('world')
    expect(queue.transcript(job?.id ?? '')).toBe('hello world')
  })

  it('nudges only when asked', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.observe(running())
    clock.advance(STALL_MS)
    queue.observe(running())
    // The stall is reported, but nothing was typed into the session.
    expect(sessions.last().written).toEqual([])

    queue.nudge()
    expect(sessions.last().written).toEqual(['\r'])
  })

  it('forwards a resize to the live session and remembers it for the next one', () => {
    queue.enqueue('/mjloop:build P001-S01')
    queue.resize(100, 30)
    expect(sessions.last().resized).toEqual([[100, 30]])

    finishJob()
    queue.enqueue('/mjloop:build P001-S02')
    expect(sessions.last().options.cols).toBe(100)
    expect(sessions.last().options.rows).toBe(30)
  })

  it('ignores an exit from a session it has already finished with', () => {
    queue.enqueue('/mjloop:build P001-S01')
    const first = sessions.last()
    finishJob()

    // A late exit must not push a second copy of the job into history.
    const before = queue.jobs()
    first.end(0)
    expect(queue.jobs()).toEqual(before)
  })
})

describe('durable transcripts', () => {
  let project: TmpProject

  beforeEach(async () => {
    project = await makeTmpProject()
  })
  afterEach(async () => {
    await project.cleanup()
  })

  function transcriptDir(): string {
    return path.join(project.dir, '.mjloop', 'web', 'transcripts')
  }

  function makeQueue(overrides: { clock?: () => Date } = {}): JobQueue {
    return new JobQueue({
      cwd: project.dir,
      spawn: sessions.factory,
      clock: overrides.clock ?? clock.clock,
      onOutput: () => {},
      onChange: () => {},
      onNotice: (message) => notices.push(message),
    })
  }

  it("appends every output chunk to the job's own file on disk", async () => {
    const q = makeQueue()
    const job = q.enqueue('/mjloop:build P001-S01')
    sessions.last().emit('hello ')
    sessions.last().emit('world')

    await vi.waitFor(async () => {
      expect(await fs.readFile(path.join(transcriptDir(), `${job.id}.log`), 'utf8')).toBe('hello world')
    })
  })

  it('appends rather than clobbers when a restart reuses a job id', async () => {
    // The counter resets to 0 every boot, so two `JobQueue`s built off the
    // same clock compute the identical first id — the exact case `Job.id`'s
    // own doc names as safe only because the write is append, never overwrite.
    const first = makeQueue()
    const job = first.enqueue('/mjloop:build P001-S01')
    sessions.last().emit('run one')
    const file = path.join(transcriptDir(), `${job.id}.log`)
    await vi.waitFor(async () => {
      expect(await fs.readFile(file, 'utf8')).toBe('run one')
    })

    const restarted = makeQueue()
    expect(restarted.enqueue('/mjloop:build P001-S02').id).toBe(job.id)
    sessions.last().emit(' run two')

    await vi.waitFor(async () => {
      expect(await fs.readFile(file, 'utf8')).toBe('run one run two')
    })
  })

  it('does not let a failing durable write affect the job', async () => {
    // A plain file where the writer needs a directory: every `mkdir` under it
    // fails with `ENOTDIR`, the shape a read-only or exhausted filesystem
    // takes too, and the one this queue has no way to fix.
    await fs.writeFile(path.join(project.dir, '.mjloop'), 'not a directory')
    const q = makeQueue()
    const job = q.enqueue('/mjloop:build P001-S01')
    sessions.last().emit('hello')

    // Give the doomed write a turn to fail and be swallowed.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(q.jobs()[0]?.status).toBe('running')
    // The in-memory copy — what the live socket serves — is unaffected.
    expect(q.transcript(job.id)).toBe('hello')
    // And the write really did fail, rather than the assertion above passing
    // for an unrelated reason.
    await expect(fs.stat(transcriptDir())).rejects.toThrow()
  })

  it('keeps only the newest finished transcripts on disk, oldest dropped first', async () => {
    const dir = transcriptDir()
    await fs.mkdir(dir, { recursive: true })
    for (let index = 0; index <= TRANSCRIPT_DISK_KEEP; index += 1) {
      const file = path.join(dir, `stale-${index}.log`)
      await fs.writeFile(file, 'x')
      await fs.utimes(file, new Date(index * 1000), new Date(index * 1000))
    }

    const q = makeQueue()
    q.enqueue('/mjloop:build P001-S01')
    q.observe(running())
    q.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    sessions.last().end(0)

    await vi.waitFor(async () => {
      const remaining = await fs.readdir(dir)
      expect(remaining.filter((name) => name.startsWith('stale-'))).toHaveLength(TRANSCRIPT_DISK_KEEP)
    })
    const remaining = await fs.readdir(dir)
    // The single oldest file went — not an arbitrary member of the set.
    expect(remaining).not.toContain('stale-0.log')
    expect(remaining).toContain(`stale-${TRANSCRIPT_DISK_KEEP}.log`)
  })

  it('drops a transcript older than the retention window regardless of count', async () => {
    const dir = transcriptDir()
    await fs.mkdir(dir, { recursive: true })
    const ancient = path.join(dir, 'ancient.log')
    await fs.writeFile(ancient, 'old content')
    await fs.utimes(ancient, new Date(0), new Date(0))

    // "Now" thirty-five days after the epoch, so a file stamped at the epoch
    // is outside the thirty-day window regardless of how few files exist.
    const q = makeQueue({ clock: () => new Date(35 * 24 * 60 * 60 * 1000) })
    q.enqueue('/mjloop:build P001-S01')
    q.observe(running())
    q.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    sessions.last().end(0)

    await vi.waitFor(async () => {
      expect(await fs.readdir(dir)).not.toContain('ancient.log')
    })
  })

  it('keeps total transcript bytes under the disk cap, oldest first', async () => {
    const dir = transcriptDir()
    await fs.mkdir(dir, { recursive: true })
    // Two files that are each under the cap but together are well over it, so
    // pruning must delete the older one whole rather than trim both.
    const chunk = Math.ceil(TRANSCRIPT_DISK_MAX_BYTES * 0.6)
    const older = path.join(dir, 'older.log')
    const newer = path.join(dir, 'newer.log')
    await fs.writeFile(older, Buffer.alloc(chunk))
    await fs.utimes(older, new Date(0), new Date(0))
    await fs.writeFile(newer, Buffer.alloc(chunk))
    await fs.utimes(newer, new Date(1000), new Date(1000))

    const q = makeQueue()
    q.enqueue('/mjloop:build P001-S01')
    q.observe(running())
    q.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    sessions.last().end(0)

    await vi.waitFor(async () => {
      expect(await fs.readdir(dir)).not.toContain('older.log')
    })
    expect(await fs.readdir(dir)).toContain('newer.log')
  })

  it('keeps a single transcript over the byte cap rather than emptying the directory', async () => {
    const dir = transcriptDir()
    await fs.mkdir(dir, { recursive: true })
    // Sole survivor of the byte bound, newest by mtime (there is nothing older
    // to compare it to), already over the cap on its own — the case the byte
    // loop must not treat as "delete until it fits", because that leaves zero
    // survivors.
    const oversized = path.join(dir, 'oversized.log')
    await fs.writeFile(oversized, Buffer.alloc(TRANSCRIPT_DISK_MAX_BYTES + 1_000_000))
    // A second file, deleted by the age bound alone (mtime 0, clock past the
    // 30-day window) rather than the byte one. Both files are unlinked, if at
    // all, inside the same `Promise.all` in `pruneTranscriptFiles`, so waiting
    // for this one's deletion — reliable, unlike waiting for `oversized.log`
    // to still be there, which would pass instantly on a fresh `readdir`
    // whether or not pruning had run yet — proves the byte-loop's decision
    // about `oversized.log` has also already been made and applied.
    const ancient = path.join(dir, 'ancient.log')
    await fs.writeFile(ancient, 'old')
    await fs.utimes(ancient, new Date(0), new Date(0))

    const q = makeQueue({ clock: () => new Date(35 * 24 * 60 * 60 * 1000) })
    q.enqueue('/mjloop:build P001-S01')
    q.observe(running())
    q.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    sessions.last().end(0)

    await vi.waitFor(async () => {
      expect(await fs.readdir(dir)).not.toContain('ancient.log')
    })
    expect(await fs.readdir(dir)).toContain('oversized.log')
  })

  it('never deletes a transcript for a job still queued or running, however old', async () => {
    const dir = transcriptDir()
    await fs.mkdir(dir, { recursive: true })

    // Past the retention window (30 days), the same relationship the age test
    // above relies on to make its own fixture fire. Without this, "now" sits
    // at the default clock's 1_000_000ms and the file below (mtime 0) is only
    // ~11.6 days old — inside every one of the three bounds regardless of
    // protection, so the assertion below would pass whether or not the
    // protected-id filter actually did anything.
    const q = makeQueue({ clock: () => new Date(35 * 24 * 60 * 60 * 1000) })
    q.enqueue('/mjloop:build P001-S01')
    const second = q.enqueue('/mjloop:build P001-S02') // stays queued behind the first

    // A stale file for the still-queued job, as if left behind by an earlier
    // attempt. It is now outside the age window, over the count, and — being
    // the only other file — irrelevant to the byte cap: only the protected-id
    // filter stands between it and deletion.
    const queuedFile = path.join(dir, `${second.id}.log`)
    await fs.writeFile(queuedFile, 'stale')
    await fs.utimes(queuedFile, new Date(0), new Date(0))

    q.observe(running())
    q.observe(summary({ status: 'done', run_id: '2026-07-28-001' }))
    sessions.last().end(0) // finishes the first job and triggers a prune

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await fs.readFile(queuedFile, 'utf8')).toBe('stale')
  })
})
