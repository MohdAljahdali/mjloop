/**
 * Static inspection of one discovered candidate: pin its revision, fetch its
 * tree under hard bounds, parse `SKILL.md`, classify executable content,
 * inventory dependencies, check for a license, and compute a content digest
 * — producing an `ImportReport` (`schemas/skill-import.ts`) that says either
 * "here is what this package is" or "here is why this stopped".
 *
 * This module never writes a byte to disk. Staging fetched content into the
 * shared library is `writePackage`'s job (`store/skill-library-store.ts`),
 * driven by whatever CLI command calls both in sequence — and that is also
 * why this module never needs to duplicate `writePackage`'s symlink refusal:
 * that rule exists for content about to be written to a real directory, and
 * nothing here ever reaches that step. A git "symlink" tree entry (mode
 * `120000`) is fetched here as inert bytes — the text of the link target —
 * exactly like any other blob; whether it becomes a filesystem symlink is
 * decided later, by the module that actually creates files.
 *
 * "Reading a file to classify it is not executing it": every byte this
 * module looks at — a shebang line, a `package.json`'s `scripts` key, a
 * `LICENSE` file's presence — is inspected as text. Nothing here ever spawns
 * a process; that is the sandbox's job (`skill-sandbox.ts`) and it stays
 * that way by this module simply never opening that door.
 *
 * Every network call goes through `deps.fetch`, defaulting to
 * `globalThis.fetch` — never a bare `fetch(` call, verified by
 * `tests/security/skill-import.test.ts` in the same style as
 * `tests/web/boundary.test.ts`.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseFrontmatter, FrontmatterError } from '../store/frontmatter.js'
import { readBoundedText } from '../util/bounded-body.js'
import type { SkillCandidate } from '../schemas/skill-import.js'
import { ImportReportSchema, type ImportReport } from '../schemas/skill-import.js'

export interface SkillImportDeps {
  fetch: typeof globalThis.fetch
}

const defaultDeps: SkillImportDeps = { fetch: globalThis.fetch }

/** `inspectCandidate` was asked to inspect a source it has no fetch contract for yet. */
export class UnsupportedInspectionSourceError extends Error {
  constructor(source: string) {
    super(
      `inspection has no fetch contract for source "${source}" yet — only "github" resolves a pinned revision, ` +
        'a tree, and blob content today; a registry candidate needs its own content endpoint defined before this ' +
        'module can honestly fetch and inspect one, and pretending otherwise would be the exact false boundary ' +
        'claim this pipeline exists to refuse',
    )
    this.name = 'UnsupportedInspectionSourceError'
  }
}

/** A connector followed, or was handed, a response from a different host than it requested. */
export class CrossHostRedirectError extends Error {
  constructor(requestedHost: string, actualHost: string) {
    super(
      `refused a redirect from "${requestedHost}" to "${actualHost}" — inspection never follows a redirect to a ` +
        'different host, because that is exactly how a compromised or malicious endpoint would hand back content ' +
        'this project never asked to fetch',
    )
    this.name = 'CrossHostRedirectError'
  }
}

/** An API response exceeded the bound this module enforces on anything crossing the network boundary. */
export class ImportResponseTooLargeError extends Error {
  constructor(url: string, capBytes: number) {
    super(`response from "${url}" exceeded the ${capBytes}-byte import API response cap — refused, not truncated`)
    this.name = 'ImportResponseTooLargeError'
  }
}

/** The candidate's `ref` could not be resolved to an immutable commit sha through the API. */
export class RevisionPinFailedError extends Error {
  constructor(ref: string, detail: string) {
    super(`could not pin ref "${ref}" to a commit sha: ${detail} — refused rather than fetching an unpinned ref`)
    this.name = 'RevisionPinFailedError'
  }
}

/** The package tree named more entries than `MAX_TREE_ENTRIES` allows. */
export class TreeTooLargeError extends Error {
  constructor(capEntries: number) {
    super(`the package tree has more than ${capEntries} entries — refused, not truncated`)
    this.name = 'TreeTooLargeError'
  }
}

/** An entry's path is absolute, escapes the package root, or is nested past `MAX_PATH_DEPTH`. */
export class HostilePathError extends Error {
  constructor(entryPath: string, reason: string) {
    super(`refused entry "${entryPath}": ${reason}`)
    this.name = 'HostilePathError'
  }
}

/** An entry's path is nested deeper than `MAX_PATH_DEPTH` allows. */
export class PathDepthExceededError extends Error {
  constructor(entryPath: string, capDepth: number) {
    super(`refused entry "${entryPath}": nested deeper than the ${capDepth}-segment path depth cap`)
    this.name = 'PathDepthExceededError'
  }
}

/** One file's decoded content exceeded `MAX_FILE_BYTES` — the declared size is never trusted, only the decoded bytes. */
export class FileTooLargeError extends Error {
  constructor(entryPath: string, capBytes: number) {
    super(`file "${entryPath}" decoded to more than the ${capBytes}-byte per-file cap — refused, not truncated`)
    this.name = 'FileTooLargeError'
  }
}

/** The package's total decoded content exceeded `MAX_TOTAL_BYTES` across every file, even though no single file did. */
export class TotalContentTooLargeError extends Error {
  constructor(capBytes: number) {
    super(`the package's total decoded content exceeded the ${capBytes}-byte total content cap — refused, not truncated`)
    this.name = 'TotalContentTooLargeError'
  }
}

/** No request may hang forever: a slow endpoint is bounded the same way a large one is. */
const REQUEST_TIMEOUT_MS = 30_000
/** An unbounded API response is a denial of service against the user's own machine — the cap on one raw response. */
const MAX_API_RESPONSE_BYTES = 2_000_000
/** A tree naming more files than this is refused outright rather than partially inspected. */
const MAX_TREE_ENTRIES = 500
/** A path nested deeper than this is refused — a real skill package has no legitimate reason to. */
const MAX_PATH_DEPTH = 12
/** One file's decoded content may not exceed this many bytes. */
const MAX_FILE_BYTES = 200_000
/** The package's total decoded content, summed across every file, may not exceed this. */
const MAX_TOTAL_BYTES = 5_000_000

const EXECUTABLE_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.ps1'])
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/
const LICENSE_FILE = /^LICEN[SC]E(\.(md|txt))?$/i
/** A git object name — sha1 today, sha256 in a repository that has migrated. Nothing else is a pin. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** The git mode a tree entry carries for a file with the executable bit set. */
const EXECUTABLE_MODE = '100755'
/** ELF and the four Mach-O magics — a compiled binary is executable content whatever its name says. */
const BINARY_MAGICS = ['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']

interface TreeEntry {
  path: string
  sha: string
  /** The raw git mode. `100755` is the only signal git itself gives that a file is executable. */
  mode: string | null
}

interface FileContent {
  path: string
  buffer: Buffer
  text: string
  mode: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fetch and parse one JSON API response, enforcing the two rules every call
 * in this module shares: never follow a cross-host redirect, and never
 * accept an unbounded body. Mirrors `skill-discovery.ts`'s `fetchJson` —
 * duplicated rather than imported because this module's bounds (per-file,
 * total, entry-count, depth) are a different, larger set than discovery's
 * single response cap, and the two phases should be free to move those caps
 * independently of one another.
 */
async function fetchApiJson(url: string, deps: SkillImportDeps, init?: RequestInit): Promise<unknown> {
  const requestedHost = new URL(url).host
  // `redirect: 'manual'` is what makes "never follows a redirect" true. The
  // default is `'follow'`, which performs the redirected request to whatever
  // host the response names and only lets the host comparison below regret it
  // afterwards — an attacker-steered outbound connection from the user's
  // machine at the very step that claims to have refused one.
  // A request with no timeout is unbounded in time the way an uncapped body
  // is unbounded in size: a slow-loris endpoint would hang the CLI forever.
  const response = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const actualHost = new URL(response.url || url).host
  if (actualHost !== requestedHost) throw new CrossHostRedirectError(requestedHost, actualHost)
  // With `'manual'`, `response.url` stays the requested url, so the status is
  // the only thing that can report a redirect — and a redirect is a refusal.
  if (response.status >= 300 && response.status < 400) {
    throw new CrossHostRedirectError(requestedHost, response.headers.get('location') ?? '(an undisclosed location)')
  }
  if (!response.ok) throw new Error(`request to "${url}" failed: ${response.status} ${response.statusText}`)

  const text = await readBoundedText(response, MAX_API_RESPONSE_BYTES, () => new ImportResponseTooLargeError(url, MAX_API_RESPONSE_BYTES))

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`response from "${url}" is not valid JSON`)
  }
}

const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'mjloop-skill-import' }

/** Resolve `candidate.ref` to an immutable commit sha through the API, before anything else is fetched. */
async function pinRevision(candidate: SkillCandidate, deps: SkillImportDeps): Promise<string> {
  const url = `https://api.github.com/repos/${candidate.repository}/commits/${encodeURIComponent(candidate.ref)}`
  let body: unknown
  try {
    body = await fetchApiJson(url, deps, { headers: GITHUB_HEADERS })
  } catch (error) {
    if (error instanceof CrossHostRedirectError) throw error
    throw new RevisionPinFailedError(candidate.ref, error instanceof Error ? error.message : String(error))
  }
  const sha = isRecord(body) && typeof body.sha === 'string' ? body.sha : null
  if (sha === null) throw new RevisionPinFailedError(candidate.ref, 'the commits API returned no sha for this ref')
  // The "pinned revision" is a value that originates entirely in untrusted
  // remote content and is then interpolated into the path of every request
  // that follows. A source answering `{"sha":"main"}` would leave the pipeline
  // fetching a moving branch while the report printed a revision, and one
  // answering `{"sha":"../../../gists/abc"}` would move the request to a
  // different path on the same host. Only a real object name is a pin.
  if (!COMMIT_SHA.test(sha)) {
    throw new RevisionPinFailedError(candidate.ref, `the commits API returned "${sha}", which is not a 40- or 64-character hex commit sha`)
  }
  return sha
}

/** Refuse an entry path that is absolute, escapes the package root, or is nested past the depth cap. */
function validateEntryPath(entryPath: string): void {
  if (path.isAbsolute(entryPath) || entryPath.startsWith('/') || entryPath.startsWith('\\')) {
    throw new HostilePathError(entryPath, 'an absolute path is never a legitimate entry in a package tree')
  }
  const segments = entryPath.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new HostilePathError(entryPath, 'a ".." segment escapes the package root and is always refused')
  }
  if (segments.length > MAX_PATH_DEPTH) throw new PathDepthExceededError(entryPath, MAX_PATH_DEPTH)
}

/** Fetch the pinned revision's tree, refusing a hostile path the moment its name first appears. */
async function fetchTree(repository: string, sha: string, deps: SkillImportDeps): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${repository}/git/trees/${sha}?recursive=1`
  const body = await fetchApiJson(url, deps, { headers: GITHUB_HEADERS })
  if (!isRecord(body) || !Array.isArray(body.tree)) {
    throw new Error(`tree response for "${repository}"@"${sha}" is malformed: expected a "tree" array`)
  }
  // GitHub itself gives up listing the whole tree past its own limit and
  // reports `truncated: true` rather than omitting entries silently — that
  // is exactly the "package too large to safely enumerate" case this cap
  // exists to catch, so it is refused the same way an explicit count is.
  if (body.truncated === true) throw new TreeTooLargeError(MAX_TREE_ENTRIES)

  const entries: TreeEntry[] = []
  for (const raw of body.tree) {
    if (!isRecord(raw)) continue
    const entryPath = typeof raw.path === 'string' ? raw.path : null
    const type = typeof raw.type === 'string' ? raw.type : null
    const entrySha = typeof raw.sha === 'string' ? raw.sha : null
    if (entryPath === null || type === null || entrySha === null) continue
    // Directories and submodule pointers are not file content — skip them
    // rather than trying to fetch blob content that does not exist for them.
    if (type !== 'blob') continue
    validateEntryPath(entryPath)
    entries.push({ path: entryPath, sha: entrySha, mode: typeof raw.mode === 'string' ? raw.mode : null })
    if (entries.length > MAX_TREE_ENTRIES) throw new TreeTooLargeError(MAX_TREE_ENTRIES)
  }
  return entries
}

/**
 * Fetch every file's content, bounded per file and in total. The declared
 * `size` field in a blob response is never trusted — only the decoded byte
 * length is checked, because a zip-bomb-shaped response understates its own
 * size in exactly that field.
 */
async function fetchBlobs(repository: string, entries: TreeEntry[], deps: SkillImportDeps): Promise<FileContent[]> {
  const files: FileContent[] = []
  let total = 0
  for (const entry of entries) {
    const url = `https://api.github.com/repos/${repository}/git/blobs/${entry.sha}`
    const body = await fetchApiJson(url, deps, { headers: GITHUB_HEADERS })
    if (!isRecord(body) || typeof body.content !== 'string') {
      throw new Error(`blob response for "${entry.path}" is malformed: expected a "content" string`)
    }
    const encoding = typeof body.encoding === 'string' ? body.encoding : 'base64'
    const buffer = encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8')

    if (buffer.byteLength > MAX_FILE_BYTES) throw new FileTooLargeError(entry.path, MAX_FILE_BYTES)
    total += buffer.byteLength
    if (total > MAX_TOTAL_BYTES) throw new TotalContentTooLargeError(MAX_TOTAL_BYTES)

    files.push({ path: entry.path, buffer, text: buffer.toString('utf8'), mode: entry.mode })
  }
  return files
}

/**
 * sha256 over the canonical sorted content: every file's path and bytes, in
 * ascending path order.
 *
 * Exported because the digest is the library's content address, and whatever
 * bytes are eventually written under it have to be checked against *this*
 * function — a caller that stages content it hashed some other way (or did not
 * hash at all) would be storing a package the digest does not describe.
 */
export function computePackageDigest(files: Array<{ path: string; buffer: Buffer }>): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const hash = createHash('sha256')
  for (const file of sorted) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.buffer)
    hash.update('\0')
  }
  return hash.digest('hex')
}

interface Classification {
  executable: boolean
  interpreter: string | null
}

/**
 * A file counts as executable if it has a shebang, git's executable mode bit,
 * a compiled binary's magic number, or an extension in the fixed set — read to
 * classify, never run.
 *
 * The mode bit matters on its own: a file called `setup` whose body is
 * `curl … | sh`, with no shebang and no extension, is executable in the only
 * sense git records, and a classification that misses it reports the package
 * as instruction-only — which skips the sandbox entirely and passes the audit.
 * The magic numbers matter because the mode is a field a hostile source
 * controls, so it must not be the only line of defence.
 */
function classifyFile(file: FileContent): Classification {
  const shebangMatch = SHEBANG.exec(file.text)
  if (shebangMatch !== null && shebangMatch[1] !== undefined) {
    return { executable: true, interpreter: path.basename(shebangMatch[1]) }
  }
  if (file.mode === EXECUTABLE_MODE) return { executable: true, interpreter: null }
  if (BINARY_MAGICS.includes(file.buffer.subarray(0, 4).toString('hex'))) return { executable: true, interpreter: null }
  if (EXECUTABLE_EXTENSIONS.has(path.extname(file.path))) return { executable: true, interpreter: null }
  return { executable: false, interpreter: null }
}

interface PackageJson {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

function parsePackageJson(text: string): PackageJson | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? (parsed as PackageJson) : null
  } catch {
    return null
  }
}

/** Package names from `requirements.txt`-style lines: strip comments and version specifiers, keep the bare name. */
function parseRequirementsTxt(text: string): string[] {
  const names: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (line.length === 0) continue
    const name = line.split(/[<>=!~\s]/)[0]?.trim()
    if (name !== undefined && name.length > 0) names.push(name)
  }
  return names
}

/**
 * Static inspection of one discovered candidate. In order: pin the revision,
 * fetch the tree under bounds, fetch file content under bounds, parse
 * `SKILL.md`, check for a license, classify executable content, and
 * inventory dependencies — never resolving or installing anything.
 *
 * Hard boundary violations (a cross-host redirect, a revision that cannot be
 * pinned, a hostile path, any bound exceeded) throw a named error — the
 * pipeline cannot safely continue past one of these, so there is no
 * meaningful partial report to return. Content-quality findings that this
 * function *can* still report on — a missing `SKILL.md`, malformed
 * frontmatter, a missing license — are returned as a blocking `ImportReport`
 * instead, because a caller asking "why did this package fail" deserves the
 * digest, the tree, and everything else that could still be determined
 * alongside the answer.
 */
export async function inspectCandidate(
  _projectDir: string,
  candidate: SkillCandidate,
  deps: SkillImportDeps = defaultDeps,
): Promise<ImportReport> {
  if (candidate.source !== 'github') throw new UnsupportedInspectionSourceError(candidate.source)

  const revision = await pinRevision(candidate, deps)
  const entries = await fetchTree(candidate.repository, revision, deps)
  const files = await fetchBlobs(candidate.repository, entries, deps)

  const findings: string[] = []
  let blocking = false
  let skillName: string | null = null
  let description: string | null = null

  const skillMd = files.find((file) => file.path === 'SKILL.md')
  if (skillMd === undefined) {
    findings.push('no SKILL.md at the package root — a package without one is not a skill and is refused')
    blocking = true
  } else {
    try {
      const { data } = parseFrontmatter(skillMd.text)
      const name = isRecord(data) && typeof data.name === 'string' ? data.name : null
      const desc = isRecord(data) && typeof data.description === 'string' ? data.description : null
      if (name === null || desc === null) {
        findings.push('SKILL.md frontmatter is missing a required "name" or "description" field')
        blocking = true
      } else {
        skillName = name
        description = desc
      }
    } catch (error) {
      if (error instanceof FrontmatterError) {
        findings.push(`SKILL.md has no valid frontmatter block: ${error.message}`)
        blocking = true
      } else {
        throw error
      }
    }
  }

  const licenseFileEntry = files.find((file) => !file.path.includes('/') && LICENSE_FILE.test(file.path))
  const frontmatterLicense =
    skillMd !== undefined
      ? (() => {
          try {
            const { data } = parseFrontmatter(skillMd.text)
            return isRecord(data) && typeof data.license === 'string' ? data.license : null
          } catch {
            return null
          }
        })()
      : null
  const licenseFile = licenseFileEntry?.path ?? null
  if (frontmatterLicense === null && licenseFile === null) {
    findings.push(
      'no license found: no SPDX id in SKILL.md frontmatter and no LICENSE file at the package root — a missing license blocks acceptance',
    )
    blocking = true
  }

  const executableFiles: string[] = []
  const interpreters = new Set<string>()
  const packages = new Set<string>()

  for (const file of files) {
    const classification = classifyFile(file)
    if (classification.executable) {
      executableFiles.push(file.path)
      if (classification.interpreter !== null) interpreters.add(classification.interpreter)
    }

    if (file.path === 'package.json') {
      const pkg = parsePackageJson(file.text)
      if (pkg !== null) {
        if (isRecord(pkg.scripts) && Object.keys(pkg.scripts).length > 0 && !executableFiles.includes(file.path)) {
          executableFiles.push(file.path)
        }
        for (const name of Object.keys(pkg.dependencies ?? {})) packages.add(name)
        for (const name of Object.keys(pkg.devDependencies ?? {})) packages.add(name)
      }
    }
    if (file.path === 'requirements.txt') {
      for (const name of parseRequirementsTxt(file.text)) packages.add(name)
    }
  }

  const digest = computePackageDigest(files)
  const auditState: ImportReport['auditState'] = blocking ? 'failed' : 'pending'
  const nextAction = blocking ? { action: 'search-alternative' as const, query: candidate.skillName } : null

  return ImportReportSchema.parse({
    schema: 1,
    candidate,
    revision,
    digest,
    skillName,
    description,
    license: { spdx: frontmatterLicense, file: licenseFile },
    dependencies: { executables: [...interpreters].sort(), packages: [...packages].sort() },
    executableFiles,
    findings,
    blocking,
    sandbox: null,
    auditState,
    nextAction,
  })
}
