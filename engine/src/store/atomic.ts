import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'

export class StateCorruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateCorruptedError'
  }
}

export interface WriteOptions {
  /** Copy the existing file to `<file>.bak` first. Default true. */
  backup?: boolean
  /**
   * Stage rename sources inside a lock directory owned by the caller. The
   * directory is deliberately never created here: stale-lock reclamation must
   * make a delayed old writer's final rename fail, not let it recreate its
   * former lock and publish.
   */
  stagingDir?: string
}

/**
 * Atomically replace a text document while retaining its exact spelling.
 *
 * JSON state is rendered by this module, but YAML comments and ordering belong
 * to the person who wrote them. The config mutator prepares the string and
 * this function only guarantees backup + indivisible landing.
 */
export async function writeTextAtomic(file: string, text: string, options: WriteOptions = {}): Promise<void> {
  const { backup = true, stagingDir } = options
  await fs.mkdir(path.dirname(file), { recursive: true })
  const stage = stagingDir ?? path.dirname(file)
  const nonce = `${process.pid}.${randomUUID()}`
  const temp = path.join(stage, `${path.basename(file)}.${nonce}.tmp`)
  const backupTemp = path.join(stage, `${path.basename(file)}.${nonce}.bak.tmp`)
  let hasBackup = false
  if (backup) {
    try {
      await fs.copyFile(file, backupTemp)
      hasBackup = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    await fs.writeFile(temp, text, 'utf8')
    if (hasBackup) await fs.rename(backupTemp, `${file}.bak`)
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    await fs.rm(backupTemp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeJsonAtomic(file: string, data: unknown, options: WriteOptions = {}): Promise<void> {
  const { backup = true, stagingDir } = options
  await fs.mkdir(path.dirname(file), { recursive: true })
  const stage = stagingDir ?? path.dirname(file)
  const nonce = `${process.pid}.${randomUUID()}`
  const temp = path.join(stage, `${path.basename(file)}.${nonce}.tmp`)
  const backupTemp = path.join(stage, `${path.basename(file)}.${nonce}.bak.tmp`)
  let hasBackup = false
  if (backup) {
    try {
      await fs.copyFile(file, backupTemp)
      hasBackup = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // The pid alone is not unique enough: two writers in the same process
  // would share one temp path, and the loser's rename would fail (or land
  // late and clobber the winner). The uuid makes every write's temp file
  // its own.
  try {
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    if (hasBackup) await fs.rename(backupTemp, `${file}.bak`)
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    await fs.rm(backupTemp, { force: true }).catch(() => undefined)
    throw error
  }
}

export interface ReadResult<T> {
  value: T
  /** True when the primary file was unusable and the value came from `.bak`. */
  recovered: boolean
}

export async function readJsonValidated<T>(file: string, schema: z.ZodType<T>): Promise<ReadResult<T>> {
  try {
    return { value: await parseFile(file, schema), recovered: false }
  } catch (primaryError) {
    let value: T
    try {
      value = await parseFile(`${file}.bak`, schema)
    } catch {
      throw new StateCorruptedError(
        `${file} is unusable and no valid backup exists: ${(primaryError as Error).message}`,
      )
    }
    // Deliberately no repair write here: reading must stay read-only, or an
    // unlocked reader racing a locked writer could regress the primary to
    // the stale backup. The caller that holds the write lock (StateStore.
    // update) persists the recovered value — with backup disabled, so the
    // corrupt primary never becomes the new backup.
    return { value, recovered: true }
  }
}

async function parseFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await fs.readFile(file, 'utf8')
  const parsed = schema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  return parsed.data
}
