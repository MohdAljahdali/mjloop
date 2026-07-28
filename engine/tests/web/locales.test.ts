import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The guard that keeps fifteen languages maintainable.
 *
 * Without it a translation drifts silently: a key renamed in English leaves the
 * other files holding a dead one, and a page that falls back per-key looks
 * fine in testing and half-English in use.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../src/web/public/', import.meta.url))
const LOCALES_DIR = path.join(PUBLIC_DIR, 'locales')

async function readLocale(code: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) as Record<string, string>
}

const codes = (await fs.readdir(LOCALES_DIR))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))

const english = await readLocale('en')
/** `{name}` holes. A translation that drops one renders a sentence with a gap in it. */
const holes = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()

describe('locales', () => {
  it('ships english as the base', () => {
    expect(codes).toContain('en')
  })

  it.each(codes.filter((code) => code !== 'en'))('%s has exactly english\'s keys', async (code) => {
    const translated = await readLocale(code)
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort())
  })

  it.each(codes)('%s leaves nothing blank', async (code) => {
    const translated = await readLocale(code)
    const blank = Object.entries(translated)
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key)
    expect(blank).toEqual([])
  })

  it.each(codes.filter((code) => code !== 'en'))('%s keeps every parameter', async (code) => {
    const translated = await readLocale(code)
    const dropped = Object.entries(english)
      .filter(([key, value]) => JSON.stringify(holes(value)) !== JSON.stringify(holes(translated[key] ?? '')))
      .map(([key]) => key)
    expect(dropped).toEqual([])
  })

  it('registers every locale file in the page', async () => {
    // A file nobody registered is a translation the user cannot pick.
    const app = await fs.readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8')
    const registry = /const LOCALES = \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? ''
    const registered = [...registry.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? '')
    expect(registered.sort()).toEqual(codes.sort())
  })

  it('carries every code the server can send', async () => {
    // The server emits `{ code, params }` and never prose, so any code it can
    // produce must have a key here or the user reads a raw identifier.
    const server = await fs.readFile(fileURLToPath(new URL('../../src/web/queue.ts', import.meta.url)), 'utf8')
    const emitted = [...server.matchAll(/code: '([\w.]+)'/g)].map((match) => match[1] ?? '')
    expect(emitted.length).toBeGreaterThan(0)
    for (const code of emitted) expect(Object.keys(english)).toContain(code)
  })
})
