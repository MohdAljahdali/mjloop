import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * True when `moduleUrl` (a module's `import.meta.url`) is the script this
 * process was launched with.
 *
 * A naive `file://${process.argv[1]}` comparison silently fails in two
 * common setups: `import.meta.url` percent-encodes special characters
 * (a path with a space never matches), and Node resolves the main module
 * through symlinks by default (every npm-installed bin is a symlink, so the
 * module URL is the real path while argv[1] is the link). Either mismatch
 * makes the bin start, do nothing, and exit 0.
 */
export async function isEntrypoint(moduleUrl: string): Promise<boolean> {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  let resolved = path.resolve(argv1)
  try {
    resolved = await fs.realpath(resolved)
  } catch {
    // argv[1] may not exist exactly as spelled (e.g. extension-less
    // invocation); keep the resolved path — pathToFileURL still normalises
    // the encoding so the comparison stays sound.
  }
  return moduleUrl === pathToFileURL(resolved).href
}
