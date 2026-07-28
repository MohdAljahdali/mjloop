import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { UsageError, parseArgs } from '../../src/web/cli.js'

describe('parseArgs', () => {
  it('defaults to the working directory and a fixed port', () => {
    expect(parseArgs([], '/work')).toEqual({ dir: '/work', port: 4177, open: true })
  })

  it('resolves --dir against the working directory', () => {
    expect(parseArgs(['--dir', 'project'], '/work').dir).toBe(path.join('/work', 'project'))
  })

  it('accepts port 0 — it asks the os for a free one', () => {
    expect(parseArgs(['--port', '0'], '/work').port).toBe(0)
  })

  it('rejects a port outside the range', () => {
    expect(() => parseArgs(['--port', '70000'], '/work')).toThrow(UsageError)
    expect(() => parseArgs(['--port', '-1'], '/work')).toThrow(UsageError)
    expect(() => parseArgs(['--port', 'http'], '/work')).toThrow(UsageError)
  })

  it('rejects a flag with no value rather than swallowing the next one', () => {
    expect(() => parseArgs(['--dir'], '/work')).toThrow(UsageError)
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--headless'], '/work')).toThrow(UsageError)
  })

  it('turns off opening a browser', () => {
    expect(parseArgs(['--no-open'], '/work').open).toBe(false)
  })
})
