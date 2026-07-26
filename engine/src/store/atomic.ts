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
}

export async function writeJsonAtomic(file: string, data: unknown, options: WriteOptions = {}): Promise<void> {
  const { backup = true } = options
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (backup) {
    try {
      await fs.copyFile(file, `${file}.bak`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
}

export interface ReadResult<T> {
  value: T
  /** True when the primary file was unusable and `.bak` was restored. */
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
    // backup:false — the corrupt primary must never become the new backup.
    await writeJsonAtomic(file, value, { backup: false })
    return { value, recovered: true }
  }
}

async function parseFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await fs.readFile(file, 'utf8')
  const parsed = schema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  return parsed.data
}
