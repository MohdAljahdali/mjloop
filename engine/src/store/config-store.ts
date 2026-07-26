import fs from 'node:fs/promises'
import path from 'node:path'
import * as YAML from 'yaml'
import * as z from 'zod'
import { ConfigSchema, type Config } from '../schemas/config.js'
import { resolveLoopPaths } from './paths.js'

export class ConfigMissingError extends Error {
  constructor(file: string) {
    super(`${file} not found — run /loop:init first`)
    this.name = 'ConfigMissingError'
  }
}

export async function loadConfig(projectDir: string): Promise<Config> {
  const file = resolveLoopPaths(projectDir).config
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigMissingError(file)
    throw error
  }
  const parsed = ConfigSchema.safeParse(YAML.parse(raw) as unknown)
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export async function writeConfig(projectDir: string, config: Config): Promise<void> {
  const file = resolveLoopPaths(projectDir).config
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, YAML.stringify(config, { lineWidth: 100 }), 'utf8')
}
