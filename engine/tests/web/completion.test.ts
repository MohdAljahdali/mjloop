import { describe, expect, it } from 'vitest'
import { NEW_TRACKER, isStalled, observe } from '../../src/web/completion.js'
import { running, summary } from '../helpers/summary.js'

describe('observe', () => {
  it('waits while no run has started', () => {
    const result = observe(NEW_TRACKER, summary({ status: 'idle' }))
    expect(result.verdict).toBe('waiting')
    expect(result.tracker.started).toBe(false)
  })

  it('starts tracking once a run is running', () => {
    const result = observe(NEW_TRACKER, running())
    expect(result.verdict).toBe('running')
    expect(result.tracker).toEqual({ started: true, runId: '2026-07-28-001' })
  })

  it.each(['done', 'halted', 'failed', 'idle'] as const)('completes on %s', (status) => {
    const started = observe(NEW_TRACKER, running()).tracker
    expect(observe(started, summary({ status, run_id: '2026-07-28-001' })).verdict).toBe('complete')
  })

  it('does not complete on paused — somebody means to come back to it', () => {
    const started = observe(NEW_TRACKER, running()).tracker
    expect(observe(started, summary({ status: 'paused', run_id: '2026-07-28-001' })).verdict).toBe('running')
  })

  it('completes when a different run id appears', () => {
    const started = observe(NEW_TRACKER, running('2026-07-28-001')).tracker
    expect(observe(started, running('2026-07-28-002')).verdict).toBe('complete')
  })

  it('never completes on a recovered summary', () => {
    // `.bak` describes the write before the last one. A run it calls finished
    // may still be mid-cycle, and ending the job would kill a live session.
    const started = observe(NEW_TRACKER, running()).tracker
    const stale = summary({ status: 'done', run_id: '2026-07-28-001', recovered: true })
    expect(observe(started, stale).verdict).toBe('running')
  })

  it('stays waiting on a recovered summary before any run started', () => {
    expect(observe(NEW_TRACKER, summary({ status: 'running', recovered: true })).verdict).toBe('waiting')
  })

  it.each(['waiting_for_user', 'budget_exhausted'] as const)('holds the job open on %s', (status) => {
    const started = observe(NEW_TRACKER, running()).tracker
    expect(observe(started, summary({ status, run_id: '2026-07-28-001' })).verdict).toBe('suspended')
  })

  it.each(['waiting_for_user', 'budget_exhausted'] as const)('attaches to a run first seen %s', (status) => {
    const result = observe(NEW_TRACKER, summary({ status, run_id: '2026-07-28-001' }))
    expect(result).toEqual({ tracker: { started: true, runId: '2026-07-28-001' }, verdict: 'suspended' })
  })
})

describe('isStalled', () => {
  it('fires once a running session passes the threshold', () => {
    expect(isStalled('running', 90_000, 90_000)).toBe(true)
    expect(isStalled('running', 89_999, 90_000)).toBe(false)
  })

  it('never fires when no run is under way', () => {
    expect(isStalled('waiting', 600_000, 90_000)).toBe(false)
    expect(isStalled('complete', 600_000, 90_000)).toBe(false)
  })

  it('never fires on a run suspended for an operator', () => {
    // A suspension is silence with a reason. Prompting about it repeatedly is
    // the polling the design forbids while a run waits for a person.
    expect(isStalled('suspended', 600_000, 90_000)).toBe(false)
  })
})
