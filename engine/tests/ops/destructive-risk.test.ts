import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ops/quality-capability.js', () => ({ qualityRuntimeEnabled: vi.fn(() => true) }))
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'

import {
  classifyDestructiveResult,
  classifyDestructiveTool,
  destructiveRequestsFile,
  guardDestructiveCommand,
  guardDestructiveOperation,
  operationFingerprint,
  readDestructiveRequests,
  type DestructiveCandidate,
} from '../../src/ops/destructive-risk.js'
import { initLoop } from '../../src/ops/init.js'
import { runStart } from '../../src/ops/run.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const clock = (): Date => new Date('2026-08-04T10:00:00.000Z')

function bashInput(command: string): unknown {
  return { tool_name: 'Bash', tool_input: { command } }
}

describe('classifyDestructiveTool', () => {
  it.each([
    ['DROP TABLE users', 'table_drop'],
    ['TRUNCATE audit_log', 'table_truncate'],
    ['DELETE FROM guests', 'bulk_data_delete'],
    ['rm -rf src/billing', 'feature_delete'],
    // The paths arrive on stdin, so the argv names no operand at all. An
    // unknown target is decided in the destructive direction, not skipped.
    ['find . -type d -name billing | xargs rm -rf', 'feature_delete'],
    ['find src/billing -name *.ts -delete', 'feature_delete'],
    ['find src/billing -name *.ts -exec rm {} +', 'feature_delete'],
    ['git clean --force -d', 'project_wide'],
    ['git clean -x -f', 'project_wide'],
  ] as const)('classifies %s as %s', (command, kind) => {
    expect(classifyDestructiveTool(bashInput(command))?.kind).toBe(kind)
  })

  it.each([
    'DELETE FROM guests WHERE id = 7',
    'rm src/unused.test.ts',
    'rm -rf node_modules',
    'git commit -m "truncate the log helper"',
  ])(
    'does not stop bounded ordinary change %s',
    (command) => {
      expect(classifyDestructiveTool(bashInput(command))).toBeNull()
    },
  )

  // The quoting a real client always carries. Removing quoted text rather than
  // the quote characters would hide exactly the statements this guard exists for.
  it('sees a statement its database client passes as one quoted argument', () => {
    expect(classifyDestructiveTool(bashInput(`psql -c "TRUNCATE audit_log"`))?.kind).toBe('table_truncate')
  })

  // A quote becomes a space rather than nothing: deleting it would weld the
  // words on either side together and the statement would stop matching.
  it('does not weld two words together where a quote separated them', () => {
    expect(classifyDestructiveTool(bashInput(`psql -c "TRUNCATE"audit_log`))?.targets).toEqual(['audit_log'])
  })
})

describe('classifyDestructiveResult', () => {
  it('catches a feature deleted through an agent’s own edits', () => {
    const candidate = classifyDestructiveResult({
      goal: 'Drop the billing experiment',
      deletedFiles: ['src/billing/index.ts', 'src/billing/invoice.ts', 'src/billing/tax.ts'],
      summary: 'Removed the code that is no longer reachable.',
    })
    expect(candidate?.kind).toBe('feature_delete')
    expect(candidate?.targets).toEqual(['src/billing'])
  })

  it('catches a feature whose files are spread over subdirectories', () => {
    const candidate = classifyDestructiveResult({
      goal: 'Drop the billing experiment',
      deletedFiles: ['src/billing/index.ts', 'src/billing/types.ts', 'src/billing/api/create.ts', 'src/billing/ui/Panel.tsx'],
      summary: 'Took out the code that is no longer reachable.',
    })
    expect(candidate?.kind).toBe('feature_delete')
    // The deepest directory that reaches the threshold: `src/billing` names the
    // feature that left, where `src` would name the project.
    expect(candidate?.targets).toEqual(['src/billing'])
  })

  it('leaves an ordinary file deletion alone', () => {
    expect(
      classifyDestructiveResult({
        goal: 'Rename the submit label',
        deletedFiles: ['src/unused.test.ts'],
        summary: 'Dropped a test that duplicated its neighbour.',
      }),
    ).toBeNull()
  })
})

/**
 * The classifier read as a whole answer rather than as a category.
 *
 * The suite above asserts `.kind`, which is the coarsest thing a candidate
 * carries: the targets an operator is shown, the rollback sentence they decide
 * against, and the operation the fingerprint is taken over all read identically
 * through it. Everything below pins the whole candidate, and pins the shapes
 * that must classify to `null` — this is the gate between an agent and an
 * irreversible operation, so both directions are load-bearing.
 */
describe('the classifier as a whole candidate', () => {
  const RECOVERABLE = 'the files are recoverable from git only if they were committed'
  const UNKNOWN = '<paths this command is given at run time>'

  describe('what is not a tool call at all', () => {
    it.each([
      ['null', null],
      ['a string', 'DROP TABLE users'],
      ['a number', 42],
      ['an array', [{ tool_name: 'Bash' }]],
      ['no tool_name', { tool_input: { command: 'DROP TABLE users' } }],
      ['a non-string tool_name', { tool_name: 7, tool_input: { command: 'DROP TABLE users' } }],
      ['no tool_input', { tool_name: 'Bash' }],
      ['a null tool_input', { tool_name: 'Bash', tool_input: null }],
      ['a non-object tool_input', { tool_name: 'Bash', tool_input: 'DROP TABLE users' }],
      ['a tool that touches nothing', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }],
      ['a bash call with no command string', { tool_name: 'Bash', tool_input: { timeout: 5 } }],
    ])('reads %s as nothing to decide', (_name, input) => {
      expect(classifyDestructiveTool(input)).toBeNull()
    })

    it('matches the bash tool however it is capitalised', () => {
      expect(classifyDestructiveTool({ tool_name: 'BASH', tool_input: { command: 'DROP TABLE users' } })?.kind)
        .toBe('table_drop')
    })

    it('reads only a plain object as a tool call', () => {
      // A function can carry the same two properties, and `typeof` tells it
      // from an object where a truthiness check would not. A hook payload is
      // parsed JSON, so anything else reaching here is a caller mistake and is
      // answered with "nothing to decide" rather than a classification.
      const callable = Object.assign(() => undefined, {
        tool_name: 'Bash',
        tool_input: { command: 'DROP TABLE users' },
      })
      expect(classifyDestructiveTool(callable)).toBeNull()
    })

    it('returns rather than reads a null hook payload', () => {
      // `typeof null === 'object'`, so the null arm is a separate guard and not
      // a consequence of the type check beside it.
      expect(classifyDestructiveTool(null)).toBeNull()
    })

    it('does not read patch syntax inside an unrelated tool\'s input', () => {
      // Only a patch tool deletes files by declaring them. The same text
      // written by a tool that edits one file is content, not an operation.
      expect(classifyDestructiveTool({
        tool_name: 'Write',
        tool_input: {
          file_path: 'docs/patch-format.md',
          content: ['a', 'b', 'c'].map((n) => `*** Delete File: src/billing/${n}.ts`).join('\n'),
        },
      })).toBeNull()
    })
  })

  describe('a patch that deletes files', () => {
    const patch = (...files: string[]): unknown => ({
      tool_name: 'apply_patch',
      tool_input: { input: files.map((file) => `*** Delete File: ${file}`).join('\n') },
    })

    it('names the directory a patch takes with it', () => {
      expect(classifyDestructiveTool(patch('src/billing/index.ts', 'src/billing/tax.ts', 'src/billing/api/create.ts')))
        .toEqual({
          kind: 'feature_delete',
          targets: ['src/billing'],
          operation: 'delete 3 files under src/billing',
          rollback: null,
        })
    })

    it.each(['apply_patch', 'applypatch', 'ApplyPatch'])('routes %s to the patch reader', (toolName) => {
      const input = {
        tool_name: toolName,
        tool_input: { input: ['a', 'b', 'c'].map((n) => `*** Delete File: src/billing/${n}.ts`).join('\n') },
      }
      expect(classifyDestructiveTool(input)?.targets).toEqual(['src/billing'])
    })

    it('leaves a patch below the feature threshold alone', () => {
      expect(classifyDestructiveTool(patch('src/billing/index.ts', 'src/billing/tax.ts'))).toBeNull()
    })

    it('ignores non-string fields beside the patch text', () => {
      const input = {
        tool_name: 'apply_patch',
        tool_input: {
          dry_run: false,
          retries: 3,
          input: ['a', 'b', 'c'].map((n) => `*** Delete File: src/billing/${n}.ts`).join('\n'),
        },
      }
      expect(classifyDestructiveTool(input)?.targets).toEqual(['src/billing'])
    })
  })

  describe('a result that removed a feature', () => {
    it('states what left, from where, and what can still be recovered', () => {
      expect(classifyDestructiveResult({
        goal: 'Drop the billing experiment',
        deletedFiles: ['src/billing/index.ts', 'src/billing/invoice.ts', 'src/billing/tax.ts'],
        summary: 'Removed the code that is no longer reachable.',
      })).toEqual({
        kind: 'feature_delete',
        targets: ['src/billing'],
        operation: 'delete 3 files under src/billing while working on: Drop the billing experiment',
        rollback: 'the deletions are recoverable from the worktree until this cycle is committed',
      })
    })

    it('catches a summary that says in words what no file count shows', () => {
      expect(classifyDestructiveResult({
        goal: 'Tidy the checkout',
        deletedFiles: [],
        summary: 'Removed the entire coupons feature.',
      })).toEqual({
        kind: 'feature_delete',
        targets: ['Tidy the checkout'],
        operation: 'remove a feature while working on: Tidy the checkout — Removed the entire coupons feature.',
        rollback: 'the change is recoverable from the worktree until this cycle is committed',
      })
    })

    it('names the files it does know about when the summary is what caught it', () => {
      expect(classifyDestructiveResult({
        goal: 'Tidy the checkout',
        deletedFiles: ['src/coupons/index.ts'],
        summary: 'Ripped out the coupons module.',
      })?.targets).toEqual(['src/coupons/index.ts'])
    })

    it.each([
      ['files at the project root name no feature', ['a.ts', 'b.ts', 'c.ts']],
      ['a rebuilt directory is not a feature', ['dist/a.js', 'dist/b.js', 'dist/c.js']],
      // A *file* named like a rebuilt directory is discounted too, and it is
      // discounted before its parent is counted — otherwise `src` here would
      // reach the threshold on two real files plus one that does not count.
      ['a file named like a rebuilt directory does not count toward its parent', ['src/a.ts', 'src/b.ts', 'src/dist']],
    ])('%s', (_name, deletedFiles) => {
      expect(classifyDestructiveResult({ goal: 'Rebuild', deletedFiles, summary: 'Cleaned up.' })).toBeNull()
    })

    it.each([
      ['beta first', ['src/beta/1.ts', 'src/beta/2.ts', 'src/beta/3.ts', 'src/alpha/1.ts', 'src/alpha/2.ts', 'src/alpha/3.ts']],
      ['alpha first', ['src/alpha/1.ts', 'src/alpha/2.ts', 'src/alpha/3.ts', 'src/beta/1.ts', 'src/beta/2.ts', 'src/beta/3.ts']],
    ])('names the deepest directory and breaks a tie by name, whatever the input order (%s)', (_name, deletedFiles) => {
      // `src` collects six and is shallower; the two depth-2 directories each
      // reach the threshold. Both orders are asserted because a tie broken by
      // input order would still satisfy one of them — the classifier has to be
      // reproducible from the same set, not from the same listing.
      expect(classifyDestructiveResult({ goal: 'Split the module', deletedFiles, summary: 'Moved things around.' })
        ?.targets).toEqual(['src/alpha'])
    })

    it('stops climbing at the filesystem root', () => {
      // The ancestor walk terminates on `/` as well as on `.`; a walk that did
      // not would never reach a fixed point for an absolute path.
      expect(classifyDestructiveResult({
        goal: 'Clear the host config',
        deletedFiles: ['/etc/app/a.conf', '/etc/app/b.conf', '/etc/app/c.conf'],
        summary: 'Cleaned up.',
      })?.targets).toEqual(['/etc/app'])
    })
  })

  describe('commands that discard uncommitted work', () => {
    it.each([
      'git reset --hard',
      'git reset --hard origin/main',
      'git clean --force -d',
      'git clean -x -f',
    ])('stops %s', (command) => {
      expect(classifyDestructiveTool(bashInput(command))).toEqual({
        kind: 'project_wide',
        targets: ['the working tree'],
        operation: command,
        rollback: 'none — the discarded work is not in any commit',
      })
    })

    it.each([
      ['a dry-run clean', 'git clean -n'],
      ['a soft reset', 'git reset --soft HEAD~1'],
    ])('leaves %s alone', (_name, command) => {
      expect(classifyDestructiveTool(bashInput(command))).toBeNull()
    })

    it('reads each stage of a pipeline on its own', () => {
      // `--force` belongs to the `xargs`, not to the `git clean`, so joining
      // the whole line into one string would stop an ordinary command.
      expect(classifyDestructiveTool(bashInput('git clean -n | xargs --force echo'))).toBeNull()
    })

    it('stops a forced clean that shares a line with ordinary work', () => {
      // One destructive stage is enough; the rest of the line being harmless
      // is not a reason to let it through.
      expect(classifyDestructiveTool(bashInput('git clean -fd && npm run build'))?.kind).toBe('project_wide')
    })
  })

  describe('whole stores and irreversible migrations', () => {
    it.each([
      ['DROP DATABASE analytics', ['analytics']],
      ['DROP SCHEMA IF EXISTS reporting', ['reporting']],
    ])('reads %s as a whole store leaving', (command, targets) => {
      expect(classifyDestructiveTool(bashInput(command))).toEqual({
        kind: 'project_wide',
        targets,
        operation: command,
        rollback: null,
      })
    })

    it.each([
      'prisma migrate reset --force',
      'npx prisma db push --accept-data-loss',
      'php artisan migrate:fresh',
      'rails db:migrate:reset',
    ])('reads %s as an irreversible migration', (command) => {
      expect(classifyDestructiveTool(bashInput(command))).toEqual({
        kind: 'irreversible_migration',
        targets: ['the project database'],
        operation: command,
        rollback: null,
      })
    })
  })

  describe('unbounded deletes', () => {
    it.each([
      ['no WHERE at all', 'DELETE FROM guests', ['guests']],
      ['a WHERE that excludes nothing', 'DELETE FROM guests WHERE 1=1', ['guests']],
      ['a WHERE that is simply true', 'DELETE FROM guests WHERE true', ['guests']],
      ['two statements in one command', 'DELETE FROM guests; DELETE FROM invites', ['guests', 'invites']],
    ])('stops %s', (_name, command, targets) => {
      expect(classifyDestructiveTool(bashInput(command))).toMatchObject({ kind: 'bulk_data_delete', targets })
    })

    it('does not read an English sentence as a table', () => {
      expect(classifyDestructiveTool(bashInput('DELETE FROM the archive by hand'))).toBeNull()
    })
  })

  describe('recursive removals', () => {
    it.each([
      ['rm -rf .', ['.']],
      ['rm -rf /', ['/']],
      ['rm -rf ~', ['~']],
    ])('reads %s as project-wide', (command, targets) => {
      expect(classifyDestructiveTool(bashInput(command))).toEqual({
        kind: 'project_wide',
        targets,
        operation: command,
        rollback: null,
      })
    })

    it('names the directories a recursive rm was actually given', () => {
      expect(classifyDestructiveTool(bashInput('rm -rf src/billing src/coupons'))).toEqual({
        kind: 'feature_delete',
        targets: ['src/billing', 'src/coupons'],
        operation: 'rm -rf src/billing src/coupons',
        rollback: RECOVERABLE,
      })
    })

    it('accepts the long flag as well as the short one', () => {
      expect(classifyDestructiveTool(bashInput('rm --recursive src/billing'))?.targets).toEqual(['src/billing'])
    })

    it.each([
      ['no trailing space', 'find . -name billing | xargs rm -rf'],
      // With a trailing space the argv ends in whitespace, and a split that did
      // not trim first would read that as a fourth, empty operand — which is an
      // operand, so the command would report a target instead of admitting it
      // does not know one yet.
      ['a trailing space', 'find . -name billing | xargs rm -rf '],
    ])('reports an unknown target when the paths arrive on stdin (%s)', (_name, command) => {
      expect(classifyDestructiveTool(bashInput(command))).toMatchObject({
        kind: 'feature_delete',
        targets: [UNKNOWN],
        rollback: 'unknown until the piped command that names the paths has run',
      })
    })

    it.each([
      ['a non-recursive rm', 'rm src/unused.ts'],
      ['a rebuilt directory', 'rm -rf dist coverage'],
      ['a command with no rm in it', 'ls -R src'],
    ])('leaves %s alone', (_name, command) => {
      expect(classifyDestructiveTool(bashInput(command))).toBeNull()
    })

    it('drops the rebuilt directories and keeps the rest', () => {
      expect(classifyDestructiveTool(bashInput('rm -rf dist src/billing'))?.targets).toEqual(['src/billing'])
    })

    it('truncates an operation too long for the reason it has to fit in', () => {
      // `halt_reason` is the only channel this proposal has, and a command is
      // as long as somebody typed. The echo is cut; the instruction is not.
      const command = `rm -rf ${Array.from({ length: 60 }, (_, i) => `src/feature-${i}/very/deep/path`).join(' ')}`
      expect(command.length).toBeGreaterThan(400)
      const candidate = classifyDestructiveTool(bashInput(command))
      expect(candidate?.operation).toHaveLength(401)
      expect(candidate?.operation.endsWith('…')).toBe(true)
    })

    it('reports an operation of exactly the maximum length untouched', () => {
      // The boundary itself: 400 characters fit, so the ellipsis would be a
      // lie about a command the operator can be shown in full.
      const head = 'rm -rf src/'
      const command = head + 'x'.repeat(400 - head.length)
      expect(command).toHaveLength(400)
      expect(classifyDestructiveTool(bashInput(command))?.operation).toBe(command)
    })
  })

  describe('find that removes what it matched', () => {
    it('names the path find was pointed at', () => {
      expect(classifyDestructiveTool(bashInput('find src/billing -name *.ts -delete'))).toEqual({
        kind: 'feature_delete',
        targets: ['src/billing'],
        operation: 'find src/billing -name *.ts -delete',
        rollback: RECOVERABLE,
      })
    })

    it('reports an unknown target when find was given no root', () => {
      expect(classifyDestructiveTool(bashInput('find -name *.ts -delete'))?.targets).toEqual([UNKNOWN])
    })

    it('survives a segment whose find has no operand at all', () => {
      // `find` last on the line matches the removal rule but not the
      // path rule, so the path match is absent rather than empty. Reading it
      // without allowing for that would throw inside a PreToolUse hook.
      expect(classifyDestructiveTool(bashInput('xargs -delete find'))?.targets).toEqual([UNKNOWN])
    })

    it.each([
      ['a find that only matches', 'find src/billing -name *.ts'],
      ['a find under a rebuilt directory', 'find dist -name *.map -delete'],
    ])('leaves %s alone', (_name, command) => {
      expect(classifyDestructiveTool(bashInput(command))).toBeNull()
    })
  })

  describe('the targets an operator is shown', () => {
    it('trims, de-duplicates, drops empties and sorts', () => {
      expect(operationFingerprint('run-1', {
        kind: 'table_drop',
        targets: [' users ', 'users', '', '  ', 'orders'],
        operation: 'DROP TABLE users, orders',
        rollback: null,
      })).toBe(operationFingerprint('run-1', {
        kind: 'table_drop',
        targets: ['orders', 'users'],
        operation: 'DROP TABLE users, orders',
        rollback: null,
      }))
    })

    it.each([
      ['./node_modules/pkg/index.js', 'a leading ./'],
      ['node_modules\\pkg\\index.js', 'windows separators'],
    ])('reads %s as rebuilt (%s)', (file) => {
      expect(classifyDestructiveResult({
        goal: 'Reinstall',
        deletedFiles: [file, `${file}.map`, `${file}.d.ts`],
        summary: 'Cleaned up.',
      })).toBeNull()
    })
  })
})

describe('operationFingerprint', () => {
  const candidate: DestructiveCandidate = {
    kind: 'table_drop',
    targets: ['users', 'orders'],
    operation: 'DROP TABLE users, orders',
    rollback: null,
  }

  it('ignores target ordering and moves with the run and the operation', () => {
    expect(operationFingerprint('run-1', { ...candidate, targets: ['orders', 'users'] })).toBe(
      operationFingerprint('run-1', candidate),
    )
    expect(operationFingerprint('run-1', { ...candidate, operation: 'DROP TABLE users, orders CASCADE' })).not.toBe(
      operationFingerprint('run-1', candidate),
    )
    expect(operationFingerprint('run-2', candidate)).not.toBe(operationFingerprint('run-1', candidate))
  })
})

describe('guardDestructiveOperation', () => {
  let project: TmpProject

  const dropUsers: DestructiveCandidate = {
    kind: 'table_drop',
    targets: ['users'],
    operation: 'DROP TABLE users',
    rollback: null,
  }

  /** Task 13 owns the operator door; a test seeds the record it will write. */
  async function seedDecision(dir: string, candidate: DestructiveCandidate, status: 'approved' | 'rejected'): Promise<void> {
    const state = await new StateStore(dir).get()
    const file = destructiveRequestsFile(dir, state)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const request = {
      run: state.run_id,
      fingerprint: operationFingerprint(state.run_id as string, candidate),
      candidate,
      status,
      requested_at: clock().toISOString(),
      decided_at: clock().toISOString(),
      decided_by: 'operator',
    }
    await fs.writeFile(file, `${JSON.stringify({ version: 1, requests: [request] }, null, 2)}\n`, 'utf8')
  }

  beforeEach(async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    project = await makeTmpProject()
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.orchestration.quality.mode = 'economy'
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
  })
  afterEach(async () => {
    await project.cleanup()
  })

  it('suspends the run and records the exact operation waiting for a decision', async () => {
    const state = await new StateStore(project.dir).get()

    const outcome = await guardDestructiveOperation(project.dir, state, dropUsers, clock)

    expect(outcome.allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
    const { requests } = await readDestructiveRequests(project.dir, state)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      run: state.run_id,
      fingerprint: operationFingerprint(state.run_id as string, dropUsers),
      candidate: dropUsers,
      status: 'pending',
    })
  })

  it('spends an approval on exactly one attempt', async () => {
    await seedDecision(project.dir, dropUsers, 'approved')
    const state = await new StateStore(project.dir).get()

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(true)
    expect((await new StateStore(project.dir).get()).status).toBe('running')

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
  })

  it('refuses an approval whose operation has since changed', async () => {
    await seedDecision(project.dir, dropUsers, 'approved')
    const state = await new StateStore(project.dir).get()

    const outcome = await guardDestructiveOperation(
      project.dir,
      state,
      { ...dropUsers, targets: ['users', 'orders'], operation: 'DROP TABLE users, orders' },
      clock,
    )

    expect(outcome.allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
  })

  it('guards a hook whose working directory is below the project root', async () => {
    // The hook is handed the session's cwd. A subagent working in a
    // subdirectory would otherwise resolve a `.mjloop` that does not exist.
    const deep = path.join(project.dir, 'src', 'billing')
    await fs.mkdir(deep, { recursive: true })

    expect((await guardDestructiveCommand(deep, dropUsers, clock)).allowed).toBe(false)
    expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
  })

  it('refuses the operation when a state file exists and cannot be read', async () => {
    const { state } = resolveLoopPaths(project.dir)
    await fs.writeFile(state, 'not json at all', 'utf8')
    await fs.rm(`${state}.bak`, { force: true })

    expect((await guardDestructiveCommand(project.dir, dropUsers, clock)).allowed).toBe(false)
  })

  it('allows the operation where there is no project to protect', async () => {
    const bare = await makeTmpProject()
    try {
      expect((await guardDestructiveCommand(bare.dir, dropUsers, clock)).allowed).toBe(true)
    } finally {
      await bare.cleanup()
    }
  })

  it('leaves the run alone while the rollout gate is closed', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
    const state = await new StateStore(project.dir).get()

    expect((await guardDestructiveOperation(project.dir, state, dropUsers, clock)).allowed).toBe(true)
    expect((await new StateStore(project.dir).get()).status).toBe('running')
  })
})
