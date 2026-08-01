import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import { resolveLibraryRoot, LibraryRootCollisionError } from '../../src/store/library-paths.js'
import {
  InvalidDigestError,
  InvalidPackageContentError,
  PackageAlreadyExistsError,
  PackageInUseError,
  listPackages,
  readPackage,
  removePackage,
  writePackage,
} from '../../src/store/skill-library-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const IMPORTED_AT = '2026-07-31T09:00:00.000Z'

function skillPackage(digest: string, overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    schema: 1,
    packageId: 'flutter-widgets',
    digest,
    source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'a1b2c3d' },
    license: { spdx: 'MIT', file: 'LICENSE' },
    skillName: 'Flutter Widgets',
    description: 'Shared widget kit conventions for the mobile component.',
    tags: ['flutter'],
    dependencies: { executables: [], packages: ['flutter'] },
    audit: { state: 'pending', findings: [], at: null },
    guidance: 'Use the shared widget kit under lib/widgets.',
    importedAt: IMPORTED_AT,
    ...overrides,
  }
}

let dataHome: string
let project: TmpProject
let contentDir: string

beforeEach(async () => {
  dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-library-'))
  process.env.MJLOOP_DATA_HOME = dataHome
  project = await makeTmpProject()
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-content-'))
  await fs.writeFile(path.join(contentDir, 'SKILL.md'), '# Flutter Widgets\n', 'utf8')
})

afterEach(async () => {
  delete process.env.MJLOOP_DATA_HOME
  await project.cleanup()
  await fs.rm(dataHome, { recursive: true, force: true })
  await fs.rm(contentDir, { recursive: true, force: true })
})

describe('resolveLibraryRoot', () => {
  it('resolves under MJLOOP_DATA_HOME when set', () => {
    expect(resolveLibraryRoot(project.dir)).toBe(dataHome)
  })

  it('refuses a root inside the project directory', () => {
    process.env.MJLOOP_DATA_HOME = path.join(project.dir, 'library')
    expect(() => resolveLibraryRoot(project.dir)).toThrow(LibraryRootCollisionError)
  })

  it('refuses a root inside a .mjloop directory anywhere', () => {
    process.env.MJLOOP_DATA_HOME = path.join(os.tmpdir(), '.mjloop', 'library')
    expect(() => resolveLibraryRoot(project.dir)).toThrow(LibraryRootCollisionError)
  })

  it('refuses a root that reaches the project through a symlink', async () => {
    // A purely textual comparison passes this: the two spellings differ, while
    // the physical directory is the same one inside the checkout.
    await fs.mkdir(path.join(project.dir, 'library'), { recursive: true })
    const link = path.join(dataHome, 'link')
    await fs.symlink(path.join(project.dir, 'library'), link)
    process.env.MJLOOP_DATA_HOME = link
    expect(() => resolveLibraryRoot(project.dir)).toThrow(LibraryRootCollisionError)
  })

  it('refuses a root inside the project when the project itself is spelled through a symlinked ancestor', async () => {
    // On macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
    // `/private/var/folders/…`, and this is how every temp project in this
    // suite is spelled — so this case needs no deliberate link at all, and it
    // is the one a real checkout under `~/Projects -> /Volumes/…` hits too.
    process.env.MJLOOP_DATA_HOME = path.join(await fs.realpath(project.dir), 'library')
    expect(() => resolveLibraryRoot(project.dir)).toThrow(LibraryRootCollisionError)
  })
})

describe('listPackages / readPackage / writePackage', () => {
  it('is empty on a machine with no library yet', async () => {
    expect(await listPackages(project.dir)).toEqual({ packages: [], unreadable: [] })
  })

  it('round-trips a package through disk, content included', async () => {
    const record = skillPackage(DIGEST_A)
    await writePackage(project.dir, record, contentDir)

    expect(await readPackage(project.dir, DIGEST_A)).toEqual(record)
    expect((await listPackages(project.dir)).packages).toEqual([record])

    const contentFile = path.join(dataHome, 'packages', DIGEST_A, 'content', 'SKILL.md')
    expect(await fs.readFile(contentFile, 'utf8')).toContain('Flutter Widgets')
  })

  it('reads null for a digest never written', async () => {
    expect(await readPackage(project.dir, DIGEST_A)).toBeNull()
  })

  it('refuses to overwrite an existing digest directory', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await expect(writePackage(project.dir, skillPackage(DIGEST_A), contentDir)).rejects.toThrow(PackageAlreadyExistsError)
  })

  it('keeps two digests of the same source as two independent directories', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await writePackage(project.dir, skillPackage(DIGEST_B, { source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'z9y8x7w' } }), contentDir)

    const { packages } = await listPackages(project.dir)
    expect(packages.map((p) => p.digest).sort()).toEqual([DIGEST_A, DIGEST_B])
  })

  it('validates every digest before it is joined into a path', async () => {
    await expect(readPackage(project.dir, '../../../etc/passwd')).rejects.toThrow(InvalidDigestError)
    await expect(readPackage(project.dir, path.resolve('/etc/passwd'))).rejects.toThrow(InvalidDigestError)
    await expect(readPackage(project.dir, 'a'.repeat(63))).rejects.toThrow(InvalidDigestError)
    await expect(readPackage(project.dir, 'a'.repeat(65))).rejects.toThrow(InvalidDigestError)
    await expect(readPackage(project.dir, 'A'.repeat(64))).rejects.toThrow(InvalidDigestError)
    // A unicode lookalike for a hex digit is not itself a hex digit.
    await expect(readPackage(project.dir, `а${'a'.repeat(63)}`)).rejects.toThrow(InvalidDigestError)
  })

  it('skips an entry whose record does not parse, and reports it, rather than failing the whole walk', async () => {
    // The library is machine-wide: the corrupt entry below can be one another
    // project imported, and this project — which accepted nothing from it —
    // must still be able to see its own library.
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await fs.mkdir(path.join(dataHome, 'packages', DIGEST_B), { recursive: true })
    await fs.writeFile(path.join(dataHome, 'packages', DIGEST_B, 'package.json'), '{"schema":1}', 'utf8')

    const { packages, unreadable } = await listPackages(project.dir)
    expect(packages.map((p) => p.digest)).toEqual([DIGEST_A])
    expect(unreadable.map((entry) => entry.digest)).toEqual([DIGEST_B])
    expect(unreadable[0]?.reason).toContain('not a valid skill package')
  })

  it('skips a plain file sitting where a digest directory belongs', async () => {
    await fs.mkdir(path.join(dataHome, 'packages'), { recursive: true })
    await fs.writeFile(path.join(dataHome, 'packages', DIGEST_A), 'not a directory', 'utf8')
    // ENOTDIR reads the same way ENOENT does: there is no package record at
    // that digest, which is an absence and not a corruption.
    expect(await readPackage(project.dir, DIGEST_A)).toBeNull()
    expect(await listPackages(project.dir)).toEqual({ packages: [], unreadable: [] })
  })

  it('refuses package content containing a symlink, before anything lands in the library', async () => {
    const secret = path.join(dataHome, 'secret.txt')
    await fs.writeFile(secret, 'TOP SECRET\n', 'utf8')
    await fs.symlink(secret, path.join(contentDir, 'leak'))

    await expect(writePackage(project.dir, skillPackage(DIGEST_A), contentDir)).rejects.toThrow(
      InvalidPackageContentError,
    )
    // Nothing partial: the digest directory was never created.
    expect(await readPackage(project.dir, DIGEST_A)).toBeNull()
  })

  it('refuses an ordinary intra-package relative link too — a copied link does not survive its staging directory', async () => {
    await fs.mkdir(path.join(contentDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(contentDir, 'LICENSE'), 'MIT\n', 'utf8')
    await fs.symlink(path.join('..', 'LICENSE'), path.join(contentDir, 'sub', 'LICENSE'))

    await expect(writePackage(project.dir, skillPackage(DIGEST_A), contentDir)).rejects.toThrow(
      InvalidPackageContentError,
    )
  })

  it('never executes anything from content — writePackage only copies files', async () => {
    await fs.writeFile(path.join(contentDir, 'run.sh'), '#!/bin/sh\necho should-never-run\n', 'utf8')
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    // The file lands on disk; nothing in this module ever invokes it. This
    // test asserts the observable half of that promise — the file is inert
    // bytes on disk, exactly as it was handed in.
    const copied = await fs.readFile(path.join(dataHome, 'packages', DIGEST_A, 'content', 'run.sh'), 'utf8')
    expect(copied).toContain('should-never-run')
  })
})

describe('removePackage', () => {
  it('deletes a package with no referencing acceptance', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await removePackage(project.dir, DIGEST_A, [])
    expect(await readPackage(project.dir, DIGEST_A)).toBeNull()
  })

  it('refuses to delete a package this project still references', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await expect(removePackage(project.dir, DIGEST_A, ['flutter-widgets'])).rejects.toThrow(PackageInUseError)
    expect(await readPackage(project.dir, DIGEST_A)).not.toBeNull()
  })

  it('validates the digest before deleting anything', async () => {
    await expect(removePackage(project.dir, '../../../etc', [])).rejects.toThrow(InvalidDigestError)
  })
})

describe('cross-project isolation', () => {
  it('two projects sharing one library each keep their own digest, and both survive', async () => {
    const other = await makeTmpProject()
    try {
      await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
      await writePackage(other.dir, skillPackage(DIGEST_B, { source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'z9y8x7w' } }), contentDir)

      // Same MJLOOP_DATA_HOME, so both projects see the same physical library.
      const fromProject = await listPackages(project.dir)
      const fromOther = await listPackages(other.dir)
      expect(fromProject.packages.map((p) => p.digest).sort()).toEqual([DIGEST_A, DIGEST_B])
      expect(fromOther.packages.map((p) => p.digest).sort()).toEqual([DIGEST_A, DIGEST_B])

      await removePackage(project.dir, DIGEST_A, [])
      expect(await readPackage(project.dir, DIGEST_A)).toBeNull()
      expect(await readPackage(other.dir, DIGEST_B)).not.toBeNull()
    } finally {
      await other.cleanup()
    }
  })
})
