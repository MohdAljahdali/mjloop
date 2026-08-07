import { describe, expect, it } from 'vitest'
import { cardInfo, liveStatus } from '../../src/web/app/lib/agentcard.js'
import type { AgentsView, RosterView } from '../../src/web/app/types/protocol.js'

const AGENTS: AgentsView = {
  project: [
    { name: 'builder', description: 'project builder', tools: 'Read, Edit', model: null, source: 'project', extra: {}, body: '', digest: '' },
  ],
  plugin: [
    { name: 'builder', description: 'plugin builder', tools: 'Read', model: 'sonnet', source: 'plugin', extra: {}, body: '', digest: '' },
    { name: 'verifier', description: 'judges work', tools: null, model: null, source: 'plugin', extra: {}, body: '', digest: '' },
  ],
  unreadable: [],
}

describe('cardInfo', () => {
  it('lets a project agent shadow the plugin agent of the same name', () => {
    const card = cardInfo('builder', AGENTS)
    expect(card.description).toBe('project builder')
    expect(card.source).toBe('project')
    expect(card.tools).toEqual(['Read', 'Edit'])
  })

  it('marks an agent with no definition file as missing, and survives a null view', () => {
    expect(cardInfo('ghost', AGENTS).source).toBeNull()
    expect(cardInfo('builder', null)).toEqual({ name: 'builder', description: null, tools: [], model: null, source: null })
  })

  it('reads empty tools as an empty list, not [""]', () => {
    expect(cardInfo('verifier', AGENTS).tools).toEqual([])
  })
})

describe('liveStatus', () => {
  const roster: RosterView = { cycle: 2, selected: ['builder', 'verifier'], landed: ['builder'] }

  it('is idle unless this exact track is the one running', () => {
    expect(liveStatus('builder', 'build', { status: 'running', track: 'fix' }, roster)).toBe('idle')
    expect(liveStatus('builder', 'build', { status: 'idle', track: 'build' }, roster)).toBe('idle')
    expect(liveStatus('builder', 'build', { status: 'running', track: 'build' }, null)).toBe('idle')
  })

  it('reads landed before selected, and an undrafted agent as idle', () => {
    const state = { status: 'running', track: 'build' } as const
    expect(liveStatus('builder', 'build', state, roster)).toBe('landed')
    expect(liveStatus('verifier', 'build', state, roster)).toBe('running')
    expect(liveStatus('scout', 'build', state, roster)).toBe('idle')
  })
})
