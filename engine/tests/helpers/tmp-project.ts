import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface TmpProject {
  dir: string
  cleanup: () => Promise<void>
}

/** A throwaway directory standing in for a host project. */
export async function makeTmpProject(files: Record<string, string> = {}): Promise<TmpProject> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-test-'))
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents, 'utf8')
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}
