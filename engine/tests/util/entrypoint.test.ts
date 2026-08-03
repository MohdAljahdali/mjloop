import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isEntrypoint } from '../../src/util/entrypoint.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const originalArgv1 = process.argv[1]
let project: TmpProject | undefined

afterEach(async () => {
  if (originalArgv1 !== undefined) process.argv[1] = originalArgv1
  await project?.cleanup()
  project = undefined
})

describe('isEntrypoint', () => {
  it('matches a symlinked argv[1] pointing into a directory with spaces', async () => {
    project = await makeTmpProject({ 'dir with space/main.js': '' })
    const real = path.join(project.dir, 'dir with space', 'main.js')
    const link = path.join(project.dir, 'bin-link.js')
    await fs.symlink(real, link)

    // Node resolves the main module through symlinks and percent-encodes its
    // URL; reproduce both to stand in for that module's import.meta.url.
    const moduleUrl = pathToFileURL(await fs.realpath(real)).href
    expect(moduleUrl).toContain('%20') // the naive `file://${argv[1]}` never matches this

    process.argv[1] = link
    expect(await isEntrypoint(moduleUrl)).toBe(true)
  })

  it('is false for a module that is not the launched script', async () => {
    expect(await isEntrypoint(import.meta.url)).toBe(false)
  })
})
