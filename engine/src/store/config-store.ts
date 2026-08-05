import fs from 'node:fs/promises'
import path from 'node:path'
import * as YAML from 'yaml'
import * as z from 'zod'
import {
  ConfigSchema,
  LEGACY_CONFIG_KEYS,
  type Config,
  type QualityConfigSource,
} from '../schemas/config.js'
import { resolveLoopPaths } from './paths.js'

export class ConfigMissingError extends Error {
  constructor(file: string) {
    super(`${file} not found — run /mjloop:init first`)
    this.name = 'ConfigMissingError'
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function qualityConfigSource(document: unknown): QualityConfigSource {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return 'default-existing'
  if (!hasOwn(document, 'orchestration')) return 'default-existing'

  const orchestration = (document as Record<string, unknown>).orchestration
  if (typeof orchestration !== 'object' || orchestration === null || Array.isArray(orchestration)) {
    return 'default-existing'
  }
  if (!hasOwn(orchestration, 'quality')) return 'default-existing'

  const quality = (orchestration as Record<string, unknown>).quality
  if (typeof quality !== 'object' || quality === null || Array.isArray(quality)) return 'default-existing'
  if (hasOwn(quality, 'mode')) return 'explicit'
  if (hasOwn(quality, 'independent_plan_review') || hasOwn(quality, 'independent_verification')) return 'legacy'
  return 'default-existing'
}

export async function loadConfigRecord(
  projectDir: string,
): Promise<{ config: Config; qualitySource: QualityConfigSource }> {
  const file = resolveLoopPaths(projectDir).config
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigMissingError(file)
    throw error
  }
  let document: unknown
  try {
    document = YAML.parse(raw) as unknown
  } catch (error) {
    // A schema failure names the file; a syntax error in the same hand-edited
    // file must not escape as a bare parser message from every op that loads
    // config. Duplicate keys arrive here too — `specialists.security` cannot be
    // both `always` and `never`, because YAML refuses the document outright.
    throw new Error(`${file} is not valid YAML:\n${(error as Error).message}`)
  }
  const qualitySource = qualityConfigSource(document)
  const stripped =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? Object.fromEntries(
          Object.entries(document as Record<string, unknown>).filter(
            ([key]) => !LEGACY_CONFIG_KEYS.includes(key as (typeof LEGACY_CONFIG_KEYS)[number]),
          ),
        )
      : document
  const parsed = ConfigSchema.safeParse(stripped)
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`)
  return { config: parsed.data, qualitySource }
}

export async function loadConfig(projectDir: string): Promise<Config> {
  return (await loadConfigRecord(projectDir)).config
}

export async function writeConfig(projectDir: string, config: Config): Promise<void> {
  const file = resolveLoopPaths(projectDir).config
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, YAML.stringify(config, { lineWidth: 100 }), 'utf8')
}
