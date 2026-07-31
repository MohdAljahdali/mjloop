import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectComponents } from '../../src/ops/project-profile.js'
import type { ProjectComponent } from '../../src/schemas/project-profile.js'
import {
  DEEP_TREE,
  FLUTTER_PLUGIN_TREE,
  FLUTTER_TREE,
  FLUTTER_UNLINTED_TREE,
  MIXED_TREE,
  NESTED_TREE,
  NEXTJS_TREE,
  PYTHON_TREE,
  UNKNOWN_TREE,
  type ProjectTree,
} from '../fixtures/project-profile/trees.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-31T09:00:00.000Z')

let project: TmpProject
afterEach(async () => { await project.cleanup() })

async function detect(tree: ProjectTree): Promise<ProjectComponent[]> {
  project = await makeTmpProject(tree)
  return (await detectComponents(project.dir, () => NOW)).components
}

function byId(components: ProjectComponent[], id: string): ProjectComponent {
  const found = components.find((component) => component.id === id)
  if (found === undefined) throw new Error(`no component "${id}" in ${components.map((c) => c.id).join(', ')}`)
  return found
}

/** Every file under `dir`, with the two things a write would change. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true })
  const rows: string[] = []
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name)
    const stats = await fs.lstat(file)
    rows.push(`${path.relative(dir, file)} ${stats.size} ${stats.mtimeMs}`)
  }
  return rows.sort()
}

describe('detectComponents', () => {
  it('writes nothing to the tree it inspects', async () => {
    project = await makeTmpProject(MIXED_TREE)
    const before = await snapshot(project.dir)

    await detectComponents(project.dir, () => NOW)

    // Not a stylistic preference: this runs against a project's working tree on
    // every `mjloop init`, including one with uncommitted work in it. A detector
    // that dropped so much as a cache file there would be editing a repository
    // it was only asked to look at.
    expect(await snapshot(project.dir)).toEqual(before)
  })

  it('produces identical components on two runs of one tree', async () => {
    project = await makeTmpProject(NESTED_TREE)
    const first = await detectComponents(project.dir, () => NOW)
    const second = await detectComponents(project.dir, () => NOW)

    // Ids are the join later stories select skills on. Two scans that disagreed
    // about them would re-route a run that changed nothing.
    expect(second.components).toEqual(first.components)
    expect(second.basis).toEqual(first.basis)
  })

  it('reports roots relative to the project, never absolute', async () => {
    const components = await detect(MIXED_TREE)
    for (const component of components) {
      expect(path.isAbsolute(component.root)).toBe(false)
      expect(component.root.includes(project.dir)).toBe(false)
    }
    expect(components.map((component) => component.root)).toEqual(['admin', 'mobile', 'service'])
  })

  it('sorts components by id', async () => {
    const ids = (await detect(NESTED_TREE)).map((component) => component.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('skips a subtree it cannot list rather than failing the whole scan', async () => {
    project = await makeTmpProject({ ...MIXED_TREE, 'locked/package.json': '{"name":"locked"}\n' })
    await fs.chmod(path.join(project.dir, 'locked'), 0o000)
    try {
      // One unreadable vendored checkout must not stop `mjloop init` from
      // provisioning a project whose other directories are fine.
      const ids = (await detectComponents(project.dir, () => NOW)).components.map((component) => component.id)
      expect(ids).toEqual(['admin', 'mobile', 'service'])
    } finally {
      await fs.chmod(path.join(project.dir, 'locked'), 0o755)
    }
  })

  it('drops a directory it cannot name rather than failing the whole scan', async () => {
    // `a\b` and `D:archive` are ordinary directory names on macOS and Linux,
    // and `ComponentRootSchema` refuses both — it is guarding a hand-written
    // record against a Windows traversal, and a root this walk built out of
    // real dirents can never be one. Refusing them is still right; taking the
    // whole component map down with them is not, and it is the only hostile
    // name in the tree that was fatal while an unlistable directory and an
    // unreadable manifest were both survivable.
    project = await makeTmpProject({
      'package.json': '{"scripts":{"test":"vitest run"}}\n',
      'a\\b/setup.py': 'from setuptools import setup\nsetup()\n',
      'D:archive/setup.py': 'from setuptools import setup\nsetup()\n',
    })

    const proposed = await detectComponents(project.dir, () => NOW)
    expect(proposed.components.map((component) => component.id)).toEqual(['root'])
    expect(byId(proposed.components, 'root').verification.test).toBe('npm test')
    expect(proposed.basis).toEqual(['package.json'])
  })

  it('does not descend into a directory it cannot name', async () => {
    // Every child of an unnameable directory inherits what makes it
    // unnameable, so a manifest below one would abort the scan the same way its
    // parent would have.
    project = await makeTmpProject({
      'package.json': '{"scripts":{"test":"vitest run"}}\n',
      'a\\b/service/pyproject.toml': '[project]\nname = "buried"\n',
    })

    const proposed = await detectComponents(project.dir, () => NOW)
    expect(proposed.components.map((component) => component.id)).toEqual(['root'])
  })

  it('fails loudly when the project directory itself cannot be read', async () => {
    // Not a subtree worth skipping: reporting "no components" here would be a
    // lie about a path the caller got wrong, and it cannot see through it.
    project = await makeTmpProject()
    await expect(detectComponents(path.join(project.dir, 'nowhere'), () => NOW)).rejects.toThrow(/ENOENT/)
  })
})

describe('standalone Flutter', () => {
  it('reads flutter from the pubspec, not from a directory name', async () => {
    const components = await detect(FLUTTER_TREE)
    expect(components).toHaveLength(1)

    const root = byId(components, 'root')
    expect(root.root).toBe('.')
    expect(root.technology).toBe('flutter')
    expect(root.skillTags).toEqual(['flutter'])
    // `flutter test` because `dev_dependencies.flutter_test` is declared;
    // `flutter analyze` because an analysis_options.yaml sits beside the
    // pubspec; build stays null because a Flutter build target is
    // platform-specific and picking one would be a guess.
    expect(root.verification).toEqual({ test: 'flutter test', lint: 'flutter analyze', build: null })
  })

  it('records the manifests the decision rests on', async () => {
    project = await makeTmpProject(FLUTTER_TREE)
    const proposed = await detectComponents(project.dir, () => NOW)
    expect(proposed.basis).toEqual(['analysis_options.yaml', 'pubspec.yaml'])
    expect(proposed.generatedAt).toBe(NOW.toISOString())
  })

  it('reads flutter from one marker, and takes no command the pubspec did not earn', async () => {
    // A plugin that pins the SDK under `environment` and declares nothing else
    // is a Flutter package. It is also the row that separates the three markers
    // from each other: FLUTTER_TREE declares all three, so a detector that
    // required them together would agree with this one everywhere else.
    const plugin = byId(await detect(FLUTTER_PLUGIN_TREE), 'root')
    expect(plugin.technology).toBe('flutter')
    expect(plugin.skillTags).toEqual(['flutter'])
    // Neither command is earned: no `flutter_test` dev-dependency, no
    // analysis_options.yaml. `flutter test` here would run a harness the
    // project never declared.
    expect(plugin.verification).toEqual({ test: null, lint: null, build: null })
  })

  it('earns flutter test from the dev-dependency without earning flutter analyze', async () => {
    const unlinted = byId(await detect(FLUTTER_UNLINTED_TREE), 'root')
    expect(unlinted.technology).toBe('flutter')
    // The two gates are independent, and this is the only fixture that holds
    // one open and the other shut.
    expect(unlinted.verification).toEqual({ test: 'flutter test', lint: null, build: null })
  })

  it('never descends into a dotted or ignored directory', async () => {
    // `.dart_tool/pubspec.yaml` and `build/app/pubspec.yaml` are real files in
    // this fixture: one component, not three.
    expect(await detect(FLUTTER_TREE)).toHaveLength(1)
  })
})

describe('standalone Next.js', () => {
  it('reads next from the dependencies and the commands from the scripts', async () => {
    const components = await detect(NEXTJS_TREE)
    expect(components).toHaveLength(1)

    const root = byId(components, 'root')
    expect(root.technology).toBe('nextjs')
    expect(root.skillTags).toEqual(['nextjs'])
    expect(root.verification).toEqual({ test: 'npm test', lint: 'npm run lint', build: 'npm run build' })
  })

  it('records next.config as corroboration in the basis', async () => {
    project = await makeTmpProject(NEXTJS_TREE)
    expect((await detectComponents(project.dir, () => NOW)).basis).toEqual(['next.config.mjs', 'package.json'])
  })

  it('ignores node_modules', async () => {
    expect(await detect(NEXTJS_TREE)).toHaveLength(1)
  })
})

describe('standalone Python', () => {
  it('reads each command from the table the pyproject declares', async () => {
    const components = await detect(PYTHON_TREE)
    expect(components).toHaveLength(1)

    const root = byId(components, 'root')
    expect(root.technology).toBe('python')
    expect(root.skillTags).toEqual(['python'])
    expect(root.verification).toEqual({ test: 'pytest', lint: 'ruff check .', build: 'python -m build' })
  })

  it('omits a command whose table is absent rather than guessing it', async () => {
    project = await makeTmpProject({ 'pyproject.toml': '[project]\nname = "bare"\n' })
    const components = (await detectComponents(project.dir, () => NOW)).components
    expect(byId(components, 'root').verification).toEqual({ test: null, lint: null, build: null })
  })

  it('treats setup.py and setup.cfg as python with nothing declared', async () => {
    project = await makeTmpProject({ 'setup.py': 'from setuptools import setup\nsetup()\n' })
    const components = (await detectComponents(project.dir, () => NOW)).components
    expect(byId(components, 'root').technology).toBe('python')
    expect(byId(components, 'root').verification).toEqual({ test: null, lint: null, build: null })
  })
})

describe('a mixed repository', () => {
  it('finds one component per manifest root and prefixes every command with a cd', async () => {
    const components = await detect(MIXED_TREE)
    expect(components.map((component) => component.id)).toEqual(['admin', 'mobile', 'service'])

    expect(byId(components, 'mobile').technology).toBe('flutter')
    expect(byId(components, 'mobile').verification).toEqual({
      test: 'cd mobile && flutter test',
      lint: 'cd mobile && flutter analyze',
      build: null,
    })
    expect(byId(components, 'admin').technology).toBe('nextjs')
    expect(byId(components, 'admin').verification).toEqual({
      test: 'cd admin && npm test',
      lint: 'cd admin && npm run lint',
      build: 'cd admin && npm run build',
    })
    expect(byId(components, 'service').technology).toBe('python')
    // `[tool.ruff]` is the one table this pyproject does not declare, so lint
    // stays null rather than becoming a plausible-looking guess.
    expect(byId(components, 'service').verification).toEqual({
      test: 'cd service && pytest',
      lint: null,
      build: 'cd service && python -m build',
    })
  })

  it('does not make a component of a directory that declares nothing', async () => {
    // `docs/` holds prose, and the repository root holds no manifest at all.
    const ids = (await detect(MIXED_TREE)).map((component) => component.id)
    expect(ids).not.toContain('docs')
    expect(ids).not.toContain('root')
  })
})

describe('nested manifests', () => {
  it('gives each one its own component and lets the parent keep its own', async () => {
    const components = await detect(NESTED_TREE)
    expect(components.map((component) => component.id)).toEqual([
      'packages-dart-lib',
      'packages-site',
      'packages-ui',
      'root',
      'services-api',
    ])
    expect(byId(components, 'root').root).toBe('.')
    expect(byId(components, 'packages-site').technology).toBe('nextjs')
    expect(byId(components, 'services-api').technology).toBe('python')
  })

  it('derives the id from the root path, so a nested id keeps its parent', async () => {
    expect(byId(await detect(NESTED_TREE), 'packages-ui').root).toBe('packages/ui')
  })
})

describe('technology is decided by declared content', () => {
  it('calls a pubspec with no flutter marker unknown', async () => {
    const dartLib = byId(await detect(NESTED_TREE), 'packages-dart-lib')
    expect(dartLib.technology).toBe('unknown')
    expect(dartLib.skillTags).toEqual([])
    // `flutter analyze` on a pure-Dart package is the wrong command, so an
    // analysis_options.yaml beside a non-flutter pubspec buys nothing.
    expect(dartLib.verification).toEqual({ test: null, lint: null, build: null })
  })

  it('calls a package.json without next unknown, even with a next.config beside it', async () => {
    const ui = byId(await detect(NESTED_TREE), 'packages-ui')
    expect(ui.technology).toBe('unknown')
    expect(ui.skillTags).toEqual([])
    // Still a component, and its own scripts are still what it declares.
    expect(ui.verification).toEqual({
      test: 'cd packages/ui && npm test',
      lint: null,
      build: 'cd packages/ui && npm run build',
    })
  })

  it('records the corroborating next.config in the basis all the same', async () => {
    project = await makeTmpProject(NESTED_TREE)
    expect((await detectComponents(project.dir, () => NOW)).basis).toContain('packages/ui/next.config.js')
  })

  it('finds nothing in a repository that declares nothing, whatever its folders are called', async () => {
    // A detector that guessed from folder names would report a Flutter app in
    // `mobile/` and a console in `admin/`. There is neither.
    project = await makeTmpProject(UNKNOWN_TREE)
    const proposed = await detectComponents(project.dir, () => NOW)
    expect(proposed.components).toEqual([])
    expect(proposed.basis).toEqual([])
  })
})

describe('the depth cap', () => {
  it('reaches a manifest five directories down and no further', async () => {
    const ids = (await detect(DEEP_TREE)).map((component) => component.id)
    expect(ids).toEqual(['a-b-c-d-e'])
  })
})

describe('component ids', () => {
  it('resolves a collision deterministically in sorted-root order', async () => {
    project = await makeTmpProject({
      'apps-web/package.json': '{"name":"dash"}\n',
      'apps/web/package.json': '{"name":"slash"}\n',
    })
    const components = (await detectComponents(project.dir, () => NOW)).components
    // Sorted by root: `apps-web` < `apps/web` on the byte ordering, so the
    // first keeps the bare slug and the second is suffixed.
    expect(components.map((component) => [component.id, component.root])).toEqual([
      ['apps-web', 'apps-web'],
      ['apps-web-2', 'apps/web'],
    ])
  })

  it('quotes a root that would otherwise break the cd it is spliced into', async () => {
    project = await makeTmpProject({ 'my app/package.json': '{"scripts":{"test":"vitest run"}}\n' })
    const components = (await detectComponents(project.dir, () => NOW)).components
    expect(components[0]?.verification.test).toBe("cd 'my app' && npm test")
  })

  it('keeps a root that begins with a dash from being read as an option by cd', async () => {
    project = await makeTmpProject({ '-legacy/package.json': '{"scripts":{"test":"vitest run"}}\n' })
    const components = (await detectComponents(project.dir, () => NOW)).components
    // Quoting cannot save this one: `cd '-legacy'` fails exactly as
    // `cd -legacy` does, because the quotes are gone by the time `cd` parses
    // its argument as an option. Only a path-explicit prefix works.
    expect(components[0]?.verification.test).toBe('cd ./-legacy && npm test')
  })

  it('emits a cd prefix that the shell verify actually spawns can run', async () => {
    project = await makeTmpProject({ '-legacy/package.json': '{"scripts":{"test":"vitest run"}}\n' })
    const components = (await detectComponents(project.dir, () => NOW)).components
    const prefix = (components[0]?.verification.test ?? '').split(' && ')[0] ?? ''

    // Proven by running it rather than by reading it. `runVerify` spawns these
    // strings with `shell: true`, which is `/bin/sh -c`, and that is the
    // interpreter that rejects a bare `-legacy` with "invalid option" — so the
    // assertion above is only worth anything if this one holds.
    const shell = spawnSync('/bin/sh', ['-c', `${prefix} && exit 0`], { cwd: project.dir })
    expect(shell.status).toBe(0)
  })
})
