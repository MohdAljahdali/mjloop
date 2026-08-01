/**
 * Read a project's shape off what its manifests declare.
 *
 * **Nothing in this module writes, ever.** It runs against a host project's
 * working tree on every `mjloop init`, including one with uncommitted work in
 * it, so a cache file or a lock directory dropped here would be the engine
 * editing a repository it was only asked to look at. A test proves it by
 * snapshotting the tree — paths, sizes and mtimes — before and after.
 *
 * The other hard rule is that a technology is decided by declared content and
 * never by a directory name. A folder called `mobile` is a folder called
 * `mobile`; a `pubspec.yaml` that declares the flutter SDK is a Flutter app.
 * The difference matters because the answer is written into a record later
 * stories route work off, and a guess there is a guess nobody ever sees.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as YAML from 'yaml'
import * as z from 'zod'
import {
  ComponentRootSchema,
  ProposedProfileSchema,
  type ComponentTechnology,
  type ComponentVerification,
  type ProjectComponent,
  type ProposedProfile,
} from '../schemas/project-profile.js'
import type { Clock } from '../store/state-store.js'

/**
 * How far below the project root a manifest is still looked for.
 *
 * The root is depth 0, so a manifest at `a/b/c/d/e` is found and one at
 * `a/b/c/d/e/f` is not. The cap exists because this walk is on the critical
 * path of `mjloop init` in projects nobody has vetted: without it one symlink
 * farm or one vendored checkout turns provisioning into a full-disk scan. Five
 * clears every layout this has been pointed at — `packages/<name>`,
 * `apps/<name>`, `services/<name>/src` — with room to spare.
 */
const MAX_DEPTH = 5

/**
 * Directories never descended into.
 *
 * Every one of them holds copies of other people's manifests: `node_modules`
 * and `Pods` hold thousands, `.dart_tool` and `build` hold generated copies of
 * the project's own. Reporting those as components of *this* project would bury
 * the three real ones the person is looking at. Dotted directories are skipped
 * wholesale by the same argument — `.git`, `.venv`, `.mjloop` itself — so the
 * list only has to name the ones that are not dotted.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.mjloop',
  '.dart_tool',
  'build',
  'dist',
  'out',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'coverage',
  'Pods',
  '.gradle',
])

/**
 * The only filenames that make a directory a component. Deliberately a closed
 * list: a detector that treated any `*.toml` or any `*.yaml` as a manifest
 * would call every config directory a component.
 */
const MANIFESTS = ['pubspec.yaml', 'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg'] as const

type Manifest = (typeof MANIFESTS)[number]

/** A directory holding at least one manifest, plus what else was found beside it. */
interface Candidate {
  /** POSIX, relative to the project root. `.` for the root itself. */
  root: string
  manifests: Set<Manifest>
  /** Corroborating files found beside the manifests: `next.config.*`, `analysis_options.yaml`. */
  corroboration: Set<string>
}

export async function detectComponents(
  projectDir: string,
  now: Clock = () => new Date(),
): Promise<ProposedProfile> {
  const candidates = await collectCandidates(projectDir)
  // Sorted by root before ids are handed out, because the collision suffix
  // depends on the order: without a stated order the same tree could produce
  // `apps-web` and `apps-web-2` the other way round on a machine whose
  // filesystem lists directories differently.
  candidates.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))

  const assigned = new Set<string>()
  const components: ProjectComponent[] = []
  const basis = new Set<string>()

  for (const candidate of candidates) {
    const read = await readManifests(projectDir, candidate)
    const technology = decideTechnology(read)
    components.push({
      id: allocateId(candidate.root, assigned),
      root: candidate.root,
      technology,
      verification: deriveVerification(candidate.root, technology, read),
      skillTags: technology === 'unknown' ? [] : [technology],
    })
    for (const file of [...candidate.manifests, ...candidate.corroboration]) {
      basis.add(joinRelative(candidate.root, file))
    }
  }

  components.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Parsed rather than merely constructed: the uniqueness, sortedness and root
  // safety rules live in the schema, and a detector that hand-waved past them
  // would be the one caller allowed to write a record no reader can trust.
  return ProposedProfileSchema.parse({
    schema: 1,
    generatedAt: now().toISOString(),
    components,
    basis: [...basis].sort(),
  } satisfies z.input<typeof ProposedProfileSchema>)
}

/* ------------------------------------------------------------------ walking */

async function collectCandidates(projectDir: string): Promise<Candidate[]> {
  const found: Candidate[] = []
  await walk(projectDir, '.', 0, found)
  return found
}

async function walk(projectDir: string, relative: string, depth: number, found: Candidate[]): Promise<void> {
  const absolute = relative === '.' ? projectDir : path.join(projectDir, relative)

  let entries: Dirent[]
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch (error) {
    // A directory that cannot be listed is skipped rather than fatal: one
    // unreadable vendored checkout must not stop `mjloop init` from
    // provisioning a project whose other twenty directories are fine. Depth 0
    // is the exception — an unreadable project root is not a subtree worth
    // skipping, it is the caller pointing at nothing, and reporting "no
    // components" for it would be a lie the caller cannot see through.
    if (depth === 0) throw error
    return
  }

  const manifests = new Set<Manifest>()
  const corroboration = new Set<string>()
  const directories: string[] = []

  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, so a symlinked directory is
    // never descended into. That is the intent, not an accident: a link back
    // up the tree makes the walk unbounded, and the depth cap alone would only
    // bound how long it takes to notice.
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue
      // A directory whose name the root schema refuses drops itself, and
      // everything beneath it. `a\b` and `D:archive` are legal directory names
      // on macOS and Linux, and `ComponentRootSchema` refuses both because in a
      // hand-written record they are a Windows traversal spelled two ways. A
      // root minted here out of a real dirent can never be that traversal — but
      // it is still a root no reader will accept, so the component could never
      // be stored. Checked at the point the root is minted rather than only on
      // the finished document, because the document parse is all-or-nothing:
      // one unnameable directory there discards the whole component map,
      // including the perfectly good root component beside it, and this module
      // already treats an unlistable subdirectory and an unreadable manifest as
      // survivable rather than fatal. Minting is also the only place that
      // covers the children, which inherit whatever the parent's name did.
      if (!ComponentRootSchema.safeParse(joinRelative(relative, entry.name)).success) continue
      directories.push(entry.name)
      continue
    }
    if (!entry.isFile()) continue
    if (isManifest(entry.name)) manifests.add(entry.name)
    else if (isCorroborating(entry.name)) corroboration.add(entry.name)
  }

  // A directory is one component however many manifests it holds — the
  // component is the directory, not the file. A directory with corroborating
  // files but no manifest is not a component at all, so what was collected
  // beside them is dropped with them: a lone `next.config.js` is a leftover.
  if (manifests.size > 0) found.push({ root: relative, manifests, corroboration })

  if (depth >= MAX_DEPTH) return
  // Sorted so the recursion order is the filesystem's only in one place — the
  // ids depend on order, and `collectCandidates` sorts again for that reason,
  // but a stable walk keeps a failure reproducible.
  for (const name of directories.sort()) {
    await walk(projectDir, joinRelative(relative, name), depth + 1, found)
  }
}

function isManifest(name: string): name is Manifest {
  return (MANIFESTS as readonly string[]).includes(name)
}

/**
 * Files that corroborate a conclusion without being able to reach it alone.
 *
 * A `next.config.js` beside a `package.json` that does not depend on `next` is
 * a leftover, not a Next.js app, so it is recorded in `basis` and given no vote
 * — the story's stop condition is that only declared content decides.
 */
function isCorroborating(name: string): boolean {
  return name === 'analysis_options.yaml' || /^next\.config\.[cm]?[jt]s$/.test(name)
}

/** POSIX join that keeps `.` meaning "the project root" rather than "./x". */
function joinRelative(root: string, name: string): string {
  return root === '.' ? name : `${root}/${name}`
}

/* --------------------------------------------------------------- manifests */

interface ReadManifests {
  pubspec: { declaresFlutter: boolean; declaresFlutterTest: boolean } | null
  packageJson: { declaresNext: boolean; scripts: Set<string> } | null
  pyproject: { tables: (table: string) => boolean } | null
  /** `setup.py` or `setup.cfg`: python, and nothing more is declared. */
  setuptools: boolean
  analysisOptions: boolean
}

async function readManifests(projectDir: string, candidate: Candidate): Promise<ReadManifests> {
  const read = async (name: Manifest): Promise<string | null> => {
    if (!candidate.manifests.has(name)) return null
    try {
      return await fs.readFile(path.join(projectDir, candidate.root, name), 'utf8')
    } catch {
      // Named in a directory listing a moment ago and unreadable now: treat it
      // as absent rather than failing the scan, exactly as an unlistable
      // subdirectory is treated.
      return null
    }
  }

  const pubspecRaw = await read('pubspec.yaml')
  const packageJsonRaw = await read('package.json')
  const pyprojectRaw = await read('pyproject.toml')

  return {
    pubspec: pubspecRaw === null ? null : readPubspec(pubspecRaw),
    packageJson: packageJsonRaw === null ? null : readPackageJson(packageJsonRaw),
    pyproject: pyprojectRaw === null ? null : { tables: (table) => declaresTable(pyprojectRaw, table) },
    setuptools: candidate.manifests.has('setup.py') || candidate.manifests.has('setup.cfg'),
    analysisOptions: candidate.corroboration.has('analysis_options.yaml'),
  }
}

function readPubspec(raw: string): ReadManifests['pubspec'] {
  let document: unknown
  try {
    document = YAML.parse(raw) as unknown
  } catch {
    // A pubspec that is not valid YAML declares nothing this can act on. The
    // directory is still a component — the file is still a manifest — it just
    // has no evidence for a technology.
    return { declaresFlutter: false, declaresFlutterTest: false }
  }
  const declaresFlutterTest = hasKey(mapping(document, 'dev_dependencies'), 'flutter_test')
  return {
    // Three independent markers because a Flutter package can carry any of
    // them: an app declares `dependencies.flutter`, a test-only package
    // declares `dev_dependencies.flutter_test`, and a plugin pins the SDK it
    // needs under `environment.flutter`. A pubspec carrying none of them is a
    // pure-Dart package, and calling that Flutter would put `flutter test` in
    // front of a project that has no Flutter installed.
    declaresFlutter:
      hasKey(mapping(document, 'dependencies'), 'flutter') ||
      declaresFlutterTest ||
      hasKey(mapping(document, 'environment'), 'flutter'),
    declaresFlutterTest,
  }
}

function readPackageJson(raw: string): ReadManifests['packageJson'] {
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch {
    return { declaresNext: false, scripts: new Set() }
  }
  const scripts = mapping(document, 'scripts')
  return {
    declaresNext: hasKey(mapping(document, 'dependencies'), 'next') || hasKey(mapping(document, 'devDependencies'), 'next'),
    // Only string scripts count, for the reason `detectVerifyCommands` already
    // encodes: `"test": null` in a package.json means the script was removed.
    scripts: new Set(
      scripts === null ? [] : Object.entries(scripts).filter(([, value]) => typeof value === 'string').map(([key]) => key),
    ),
  }
}

function mapping(document: unknown, key: string): Record<string, unknown> | null {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null
  const value = (document as Record<string, unknown>)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Own-property lookup, for the reason `findTrack` uses one: a plain `in` says
 * yes to `constructor` and `toString` on every mapping there is, so a pubspec
 * with no `dependencies` block at all would "declare" whatever key it was
 * asked about.
 */
function hasKey(map: Record<string, unknown> | null, key: string): boolean {
  return map !== null && Object.hasOwn(map, key)
}

/**
 * Does this pyproject declare a table — scanned for, not parsed.
 *
 * A TOML dependency is not worth taking on for three yes/no questions, and this
 * is honest about being a scan: it matches a `[table]` header on its own line,
 * and a sub-table counts because TOML sub-tables imply their parent (a project
 * that configures only `[tool.ruff.lint]` has still configured ruff, and
 * dropping its lint command would lose verification the project really has).
 * What it can be fooled by is a header inside a multi-line string. The cost of
 * being fooled is one wrong verification command in a proposal a person reads
 * before accepting, which is the reason the proposal is a proposal.
 */
function declaresTable(raw: string, table: string): boolean {
  const escaped = table.replace(/[.[\]]/g, '\\$&')
  return new RegExp(String.raw`^[ \t]*\[${escaped}(\.[^\]]*)?\][ \t]*$`, 'm').test(raw)
}

/* ------------------------------------------------------------- conclusions */

/**
 * The stated order in which evidence is weighed.
 *
 * A directory can hold two manifests — a `package.json` beside a
 * `pyproject.toml` is an ordinary shape for a Python service with a JS build
 * step — and it is still one component. So the order has to be written down
 * rather than left to whichever file the filesystem listed first, or two scans
 * of one tree could disagree.
 */
function decideTechnology(read: ReadManifests): ComponentTechnology {
  if (read.pubspec?.declaresFlutter === true) return 'flutter'
  if (read.packageJson?.declaresNext === true) return 'nextjs'
  if (read.pyproject !== null || read.setuptools) return 'python'
  return 'unknown'
}

/**
 * Commands read from what the manifests declare, never guessed.
 *
 * Slots are filled in the same stated order `decideTechnology` weighs evidence
 * in, first non-null wins. That matters for the mixed directory above: its
 * `package.json` really does declare `npm test`, and a component that reported
 * no test command while a test command sat in its own manifest would send every
 * later run to verify it by hand.
 */
function deriveVerification(
  root: string,
  technology: ComponentTechnology,
  read: ReadManifests,
): ComponentVerification {
  const slots: ComponentVerification = { test: null, lint: null, build: null }

  // Gated on the *conclusion*, not merely on the pubspec being there: a
  // pure-Dart package can carry an analysis_options.yaml, and `flutter analyze`
  // on one is the wrong tool — `dart analyze` is the right one, and guessing
  // which is exactly what this function refuses to do.
  if (technology === 'flutter') {
    if (read.pubspec?.declaresFlutterTest === true) slots.test = 'flutter test'
    if (read.analysisOptions) slots.lint = 'flutter analyze'
    // `build` stays null on purpose. A Flutter build target is
    // platform-specific — apk, ipa, web — and picking one would be a guess.
  }

  const scripts = read.packageJson?.scripts
  if (scripts !== undefined) {
    // The same three mappings `detectVerifyCommands` already makes, so a
    // single-package repository gets identical commands from either route.
    if (slots.test === null && scripts.has('test')) slots.test = 'npm test'
    if (slots.lint === null && scripts.has('lint')) slots.lint = 'npm run lint'
    if (slots.build === null && scripts.has('build')) slots.build = 'npm run build'
  }

  const pyproject = read.pyproject
  if (pyproject !== null) {
    if (slots.test === null && pyproject.tables('tool.pytest.ini_options')) slots.test = 'pytest'
    if (slots.lint === null && pyproject.tables('tool.ruff')) slots.lint = 'ruff check .'
    if (slots.build === null && pyproject.tables('build-system')) slots.build = 'python -m build'
  }

  if (root === '.') return slots
  // A root starting with a dash is the one case quoting cannot reach: `cd
  // '-legacy'` fails exactly as `cd -legacy` does, with "invalid option",
  // because the quotes are gone before `cd` parses its argument and a leading
  // dash is how every shell spells an option. Naming it as a path is the only
  // thing that works, and it is applied only there so that the `cd apps/mobile`
  // everyone else gets stays the plain string a person expects to read.
  const target = root.startsWith('-') ? `./${root}` : root
  const prefix = `cd ${quoteForShell(target)} && `
  return {
    test: slots.test === null ? null : prefix + slots.test,
    lint: slots.lint === null ? null : prefix + slots.lint,
    build: slots.build === null ? null : prefix + slots.build,
  }
}

/**
 * The root as one shell word.
 *
 * Left bare when it needs no quoting, because that is what a person reading
 * `cd apps/mobile && flutter test` in a config expects to see and what every
 * test in this repository asserts. A root with a space in it is not exotic on
 * macOS, though, and `cd apps/my app && …` is not a command that runs — so the
 * quoting is applied exactly where it changes the meaning and nowhere else.
 */
function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9._\-/]+$/.test(value)) return value
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/* --------------------------------------------------------------------- ids */

/**
 * `.` becomes `root`; everything else is the POSIX relative path slugified, so
 * `apps/mobile` becomes `apps-mobile` and the id says where the component is.
 *
 * A path that slugs to nothing — `___`, or a name with no ASCII in it at all —
 * would produce an id `IdSchema` refuses, and refusing to propose a profile
 * because one directory is named in Arabic would be the wrong trade. It falls
 * back to a generic stem and the collision suffix keeps the ids apart.
 */
function slugifyRoot(root: string): string {
  if (root === '.') return 'root'
  const slug = root.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'component' : slug
}

/**
 * A deterministic `-2`, `-3` suffix on collision, resolved in the sorted-root
 * order the caller iterates in.
 *
 * Collisions are real rather than theoretical: `apps/web` and `apps-web` slug
 * to the same thing, and so do `apps/web` and `apps.web`. The loop rather than
 * a plain counter covers the second-order case where the suffixed id collides
 * with a slug some other root produces on its own.
 */
function allocateId(root: string, assigned: Set<string>): string {
  const base = slugifyRoot(root)
  let id = base
  let suffix = 1
  while (assigned.has(id)) {
    suffix += 1
    id = `${base}-${suffix}`
  }
  assigned.add(id)
  return id
}
