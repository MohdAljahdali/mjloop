import * as YAML from 'yaml'

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

/**
 * The opening block only. The pattern is anchored at the start and
 * non-greedy up to the first closing fence, so a `---` inside the body is
 * body text rather than a second frontmatter block.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Split a fenced block from the body without judging what is inside it.
 *
 * `null` when the file does not open with a closed `---` fence. Repair needs
 * this separately from `parseFrontmatter`: "there was a block and its yaml is
 * broken" and "there was never a block" call for different bodies, and only the
 * first one may be stripped.
 */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const match = FRONTMATTER.exec(raw)
  if (match === null) return null
  return { yaml: match[1] ?? '', body: (match[2] ?? '').trim() }
}

export function parseFrontmatter(raw: string): { data: unknown; body: string } {
  const split = splitFrontmatter(raw)
  if (split === null) {
    throw new FrontmatterError('no frontmatter block: the file must open with a --- fenced yaml block')
  }
  let data: unknown
  try {
    data = YAML.parse(split.yaml) as unknown
  } catch (error) {
    throw new FrontmatterError(`the frontmatter is not valid yaml: ${(error as Error).message}`)
  }
  return { data, body: split.body }
}

export function serialiseFrontmatter(data: unknown, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 100 }).trimEnd()
  const trimmed = body.trim()
  return trimmed.length === 0 ? `---\n${yaml}\n---\n` : `---\n${yaml}\n---\n\n${trimmed}\n`
}
