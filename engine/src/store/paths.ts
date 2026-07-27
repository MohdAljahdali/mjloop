import path from 'node:path'

export interface LoopPaths {
  root: string
  config: string
  state: string
  index: string
  designSystem: string
  plans: string
  runs: string
  memory: string
  lock: string
}

export function resolveLoopPaths(projectDir: string): LoopPaths {
  const root = path.join(projectDir, '.mjloop')
  return {
    root,
    config: path.join(root, 'config.yaml'),
    state: path.join(root, 'state.json'),
    index: path.join(root, 'INDEX.md'),
    designSystem: path.join(root, 'design-system.md'),
    plans: path.join(root, 'plans'),
    runs: path.join(root, 'runs'),
    memory: path.join(root, 'memory'),
    lock: path.join(root, '.lock'),
  }
}

/** Files only the engine may write. The PreToolUse hook denies edits to these. */
export const PROTECTED_BASENAMES = ['state.json', 'manifest.json'] as const
