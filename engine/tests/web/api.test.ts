import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { runDirName, runStart } from '../../src/ops/run.js'
import { TELEMETRY_MAX_ROWS } from '../../src/ops/telemetry.js'
import type { SkillSource } from '../../src/schemas/config.js'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import { etag, handleApi } from '../../src/web/api.js'
import { WEB_CODES } from '../../src/web/codes.js'
import { approveFeatureBrief, createFeatureBrief, updateFeatureDraft } from '../../src/store/feature-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { acceptSkill } from '../../src/store/skill-acceptance-store.js'
import { writePackage } from '../../src/store/skill-library-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The read api's two jobs: answer, and never say anything.
 *
 * "Never say anything" is the strict one. Every error is `{ error: { code } }`
 * with **no `params` at all** — a params hole is exactly how a sentence gets
 * smuggled past the no-prose rule the day a code feels too vague.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
})
afterEach(async () => {
  await project.cleanup()
})

const call = (pathname: string, method = 'GET') => handleApi(project.dir, method, pathname)

describe('handleApi', () => {
  it('leaves every non-api path alone', async () => {
    expect(await call('/')).toBe(null)
    expect(await call('/app.js')).toBe(null)
    // Not `/api`-prefixed as a *path segment* — a static file whose name merely
    // begins with those letters must still be served.
    expect(await call('/apiary.css')).toBe(null)
  })

  it('serves what the tabs read', async () => {
    expect((await call('/api/state'))?.status).toBe(200)
    expect((await call('/api/config'))?.status).toBe(200)
    expect((await call('/api/plans/P001'))?.status).toBe(200)
    expect((await call('/api/stories/P001-S01'))?.status).toBe(200)
    expect((await call('/api/stories/P001-S01/runs'))?.status).toBe(200)
    expect((await call('/api/runs'))?.status).toBe(200)
    expect((await call('/api/memory'))?.status).toBe(200)
    // The Config tab's specialist table and the idle Run tab's estimate. Both
    // are reads over run directories that already exist; neither can start
    // anything, which is why the pre-dispatch surface may live in a browser at
    // all.
    expect((await call('/api/telemetry'))?.status).toBe(200)
    expect((await call('/api/preflight/edit'))?.status).toBe(200)
    // `initLoop` scans the project, so a provisioned project always has at
    // least a proposal to report — even one that found nothing.
    expect((await call('/api/profile'))?.status).toBe(200)
  })

  it('reports the component map without offering any way to change it', async () => {
    await acceptProfile(
      project.dir,
      {
        components: [
          {
            id: 'web',
            root: 'web',
            technology: 'nextjs',
            verification: { test: 'cd web && npm test', lint: null, build: null },
            skillTags: ['nextjs'],
          },
        ],
        by: 'Mohd',
        generatedAt: NOW.toISOString(),
        expectRevision: null,
      },
      clock,
    )

    const result = await call('/api/profile')
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ revision: 1, acceptedBy: 'Mohd' })
    // Accepting a component map activates routing for every later run, which is
    // the class of write the browser is permanently denied. There is a route
    // that reads it and there is deliberately none that writes it.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('/api/profile', method))?.status).toBe(405)
    }
    // No parameter, and none a later story could smuggle in: an accepted
    // revision is immutable, so there is nothing here to select between.
    expect((await call('/api/profile/1'))?.status).toBe(404)
    expect((await call('/api/profile/../../etc'))?.status).toBe(404)
  })

  it('serves a feature brief and its history, and offers no way to author one', async () => {
    await createFeatureBrief(
      project.dir,
      {
        title: 'Passwordless sign-in',
        problem: 'Password resets are the top support cost.',
        discovery: { mode: 'ask', questionBudget: 8 },
      },
      clock,
    )
    const draft = await updateFeatureDraft(project.dir, 'F001', { acceptance: ['a mailed link signs the user in'] })
    await approveFeatureBrief(
      project.dir,
      { id: 'F001', expectRevision: 1, expectDigest: draft.digest, by: 'Mohd' },
      clock,
    )

    expect((await call('/api/features'))?.status).toBe(200)
    const detail = await call('/api/features/F001')
    expect(detail?.status).toBe(200)
    expect(detail?.body).toMatchObject({
      status: 'approved',
      revisions: [{ revision: 1, status: 'approved' }],
      // What the operator's Approve button hands back, so that a click can be
      // made conditional on the words this response actually showed.
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    // An approved brief is what a later plan is built on. There are two routes
    // that read one and deliberately none that writes one: the single feature
    // write a browser may perform is an approval, and it goes through the
    // guarded socket door in `writes.ts` where it can be made conditional on
    // the revision the operator was actually looking at.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('/api/features', method))?.status).toBe(405)
      expect((await call('/api/features/F001', method))?.status).toBe(405)
    }
    // A revision is not selectable here. The route serves the latest and the
    // history beside it, and a route that took a revision would be the first
    // half of one that set it.
    expect((await call('/api/features/F001/1'))?.status).toBe(404)
    expect((await call('/api/features/F001/rev-001.json'))?.status).toBe(404)
  })

  it("serves a run's pinned skill manifest, and offers no way to set one", async () => {
    await acceptProfile(
      project.dir,
      {
        components: [
          {
            id: 'web',
            root: 'web',
            technology: 'nextjs',
            verification: { test: 'cd web && npm test', lint: null, build: null },
            skillTags: ['nextjs'],
          },
        ],
        by: 'Mohd',
        generatedAt: NOW.toISOString(),
        expectRevision: null,
      },
      clock,
    )
    await createFeatureBrief(
      project.dir,
      {
        title: 'Passwordless sign-in',
        problem: 'Password resets are the top support cost.',
        discovery: { mode: 'ask', questionBudget: 8 },
      },
      clock,
    )
    const draft = await updateFeatureDraft(project.dir, 'F001', { acceptance: ['a mailed link signs the user in'] })
    await approveFeatureBrief(
      project.dir,
      { id: 'F001', expectRevision: 1, expectDigest: draft.digest, by: 'Mohd' },
      clock,
    )

    // Most runs name no feature at all, and `pinSkillManifest` pins nothing
    // for them — `null` is that ordinary case, not a 404 and not an invented
    // empty manifest.
    const bare = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const bareResult = await call(`/api/runs/${runDirName(bare)}/skills`)
    expect(bareResult?.status).toBe(200)
    expect(bareResult?.body).toBe(null)

    const routed = await runStart(project.dir, { track: 'edit', goal: 'Add link login', feature: 'F001' }, clock)
    const routedResult = await call(`/api/runs/${runDirName(routed)}/skills`)
    expect(routedResult?.status).toBe(200)
    expect(routedResult?.body).toMatchObject({ schema: 1, sourceBrief: { id: 'F001', revision: 1 } })

    // The routing decision a run started with is reported; nothing here lets
    // the browser set one.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call(`/api/runs/${runDirName(routed)}/skills`, method))?.status).toBe(405)
    }
  })

  it('answers 404 for a skill manifest on a run that never started', async () => {
    const result = await call('/api/runs/nope/skills')
    expect(result?.status).toBe(404)
    expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
  })

  describe('/api/stories/:id/runs', () => {
    it("serves one story's own execution history, not another's and not an ad-hoc run", async () => {
      await storyAdd(project.dir, { plan: 'P001', title: 'Session cookie' }, clock)

      const first = await runStart(project.dir, { track: 'edit', goal: 'Login form', story: 'P001-S01' }, clock)
      const second = await runStart(project.dir, { track: 'edit', goal: 'Session cookie', story: 'P001-S02' }, clock)
      // Names no story at all — must be attributed to neither.
      await runStart(project.dir, { track: 'edit', goal: 'Rename a label' }, clock)

      const forFirst = await call('/api/stories/P001-S01/runs')
      expect(forFirst?.status).toBe(200)
      expect(forFirst?.body).toMatchObject([{ id: runDirName(first), story: 'P001-S01', track: 'edit' }])

      const forSecond = await call('/api/stories/P001-S02/runs')
      expect(forSecond?.status).toBe(200)
      expect(forSecond?.body).toMatchObject([{ id: runDirName(second), story: 'P001-S02', track: 'edit' }])
    })

    it('is empty at 200 for a story with no runs yet, and 400 for an id not shaped like one', async () => {
      const result = await call('/api/stories/P001-S01/runs')
      expect(result?.status).toBe(200)
      expect(result?.body).toEqual([])

      expect((await call('/api/stories/nonsense/runs'))?.status).toBe(400)
      expect((await call('/api/stories/P1-S1/runs'))?.status).toBe(400)
    })

    it('is a read and nothing else, and refuses a third path segment', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect((await call('/api/stories/P001-S01/runs', method))?.status).toBe(405)
      }
      expect((await call('/api/stories/P001-S01/runs/extra'))?.status).toBe(404)
      expect((await call('/api/stories/P001-S01/nonsense'))?.status).toBe(404)
    })
  })

  describe('/api/transcripts', () => {
    it("serves a job's durable transcript by id", async () => {
      const dir = path.join(project.dir, '.mjloop', 'web', 'transcripts')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, '20260728T090000-1.log'), 'hello from the pty', 'utf8')

      const result = await call('/api/transcripts/20260728T090000-1')
      expect(result?.status).toBe(200)
      expect(result?.body).toBe('hello from the pty')
    })

    it('answers 404 for a job with no durable transcript, and offers no listing', async () => {
      expect((await call('/api/transcripts/20260728T090000-1'))?.status).toBe(404)
      // No index route, unlike `/api/runs` and `/api/memory`: every reader
      // here already knows the one id it wants.
      expect((await call('/api/transcripts'))?.status).toBe(404)
      expect((await call('/api/transcripts/20260728T090000-1/extra'))?.status).toBe(404)
    })

    it('refuses anything that is not shaped like a job id before reading a file', async () => {
      // `<compact ISO>-<counter>` is `Job.id`'s own shape and the traversal
      // guard at once — refused here before a path is ever built from it.
      for (const bad of ['nonsense', '2026-07-28-1', '20260728T090000', '20260728T090000-']) {
        expect((await call(`/api/transcripts/${bad}`))?.status).toBe(400)
      }
    })

    it('is a read and nothing else', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect((await call('/api/transcripts/20260728T090000-1', method))?.status).toBe(405)
      }
    })
  })

  describe('/api/skills', () => {
    const DIGEST_A = 'a'.repeat(64)
    let dataHome: string
    let contentDir: string

    function skillPackage(digest: string): SkillPackage {
      return {
        schema: 1,
        packageId: 'flutter-widgets',
        digest,
        source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'a1b2c3d' },
        license: { spdx: 'MIT', file: 'LICENSE' },
        skillName: 'Flutter Widgets',
        description: 'Shared widget kit conventions for the mobile component.',
        tags: ['flutter'],
        dependencies: { executables: [], packages: ['flutter'] },
        audit: { state: 'passed', findings: [], at: '2026-07-30T09:00:00.000Z' },
        guidance: 'Use the shared widget kit under lib/widgets.',
        importedAt: '2026-07-30T09:00:00.000Z',
      }
    }

    beforeEach(async () => {
      dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-library-'))
      process.env.MJLOOP_DATA_HOME = dataHome
      contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-content-'))
      await fs.writeFile(path.join(contentDir, 'SKILL.md'), '# Flutter Widgets\n', 'utf8')
    })

    afterEach(async () => {
      delete process.env.MJLOOP_DATA_HOME
      await fs.rm(dataHome, { recursive: true, force: true })
      await fs.rm(contentDir, { recursive: true, force: true })
    })

    it('is empty at 200 on a machine with no library and a project with no acceptances', async () => {
      const result = await call('/api/skills')
      expect(result?.status).toBe(200)
      expect(result?.body).toEqual({
        packages: [],
        unreadable: [],
        acceptances: [],
        onDisk: [],
        onDiskUnreadable: [],
      })
    })

    it('reports the library and this project\'s acceptances, and offers no way to change either', async () => {
      await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
      await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'Mohd' }, clock)

      const result = await call('/api/skills')
      expect(result?.status).toBe(200)
      expect(result?.body).toMatchObject({
        packages: [{ digest: DIGEST_A, skillName: 'Flutter Widgets' }],
        acceptances: [{ skillId: 'flutter-widgets', status: 'active' }],
      })

      // Activation is the class of write `web/writes.ts` permanently denies
      // the browser — `mjloop-cli skills accept` is where that decision is
      // made, and this route only ever reports it.
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect((await call('/api/skills', method))?.status).toBe(405)
      }
    })

    it('answers 404 for a nested path, since there is nothing here to select', async () => {
      expect((await call('/api/skills/flutter-widgets'))?.status).toBe(404)
    })
  })

  describe('GET /api/skills/search', () => {
    /** Widens `project`'s own config to allow the named sources, keeping everything else `initLoop` wrote. */
    async function allowSources(sources: SkillSource[]): Promise<void> {
      const config = await loadConfig(project.dir)
      config.orchestration.skills.sources = sources
      await writeConfig(project.dir, config)
    }

    it('is a 400 without a query of at least two characters', async () => {
      for (const path of ['/api/skills/search', '/api/skills/search?q=', '/api/skills/search?q=a']) {
        expect((await call(path))?.status, path).toBe(400)
      }
    })

    it('is a 400 for a source that is not in the enum', async () => {
      const result = await call('/api/skills/search?q=react&source=nonsense')
      expect(result?.status).toBe(400)
    })

    it('answers a code, never a sentence, when the project has not allowed the source', async () => {
      const result = await call('/api/skills/search?q=react&source=skills-sh')
      expect(result?.status).toBe(403)
      expect(result?.body).toEqual({ error: { code: 'error.skillSourceDisabled' } })
    })

    describe('with skills-sh allowed and no token in the environment', () => {
      // `discoverCandidates` is called from `api.ts` with no `deps`, so it
      // reads the real `process.env` — the route's whole point is to use the
      // ambient environment. Stubbing both variable names to an empty string
      // (rather than deleting them) is what keeps this hermetic on a
      // developer machine that happens to export a real token in its shell:
      // `vi.stubEnv` always wins over whatever the process already has, and
      // `vi.unstubAllEnvs` in `afterEach` restores it unconditionally, even
      // if an assertion above throws. The refusal fires before any request is
      // built, so this reaches no network either way.
      beforeEach(() => {
        vi.stubEnv('SKILLS_SH_TOKEN', '')
        vi.stubEnv('VERCEL_OIDC_TOKEN', '')
      })
      afterEach(() => {
        vi.unstubAllEnvs()
      })

      it('answers 503 for a missing skills.sh token, not a fault of the caller', async () => {
        await allowSources(['skills-sh'])
        const result = await call('/api/skills/search?q=react&source=skills-sh')
        expect(result?.status).toBe(503)
        expect(result?.body).toEqual({ error: { code: 'error.skillsShTokenMissing' } })
      })
    })

    it('answers 501 for general web search, which this build has no provider for', async () => {
      await allowSources(['web'])
      const result = await call('/api/skills/search?q=react&source=web')
      expect(result?.status).toBe(501)
      expect(result?.body).toEqual({ error: { code: 'error.webSearchUnavailable' } })
    })

    it('stays a 405 for a POST', async () => {
      const result = await call('/api/skills/search?q=react', 'POST')
      expect(result?.status).toBe(405)
    })
  })

  it('answers for a project that has raised no feature without describing it', async () => {
    // An empty list, not a 404: unlike the component map, whose absence changes
    // how every later run is routed, no feature yet is the ordinary state of a
    // freshly provisioned project.
    expect((await call('/api/features'))?.body).toEqual([])
    const missing = await call('/api/features/F404')
    expect(missing?.status).toBe(404)
    expect(missing?.body).toEqual({ error: { code: 'error.notFound' } })
    // Refused by the engine's own id schema before anything reads a directory.
    expect((await call('/api/features/nonsense'))?.status).toBe(400)
    expect((await call('/api/features/F1'))?.status).toBe(400)
    expect((await call('/api/features/f001'))?.status).toBe(400)
  })

  it('answers for a project nothing has ever mapped without describing it', async () => {
    const bare = await makeTmpProject()
    try {
      const result = await handleApi(bare.dir, 'GET', '/api/profile')
      expect(result?.status).toBe(404)
      expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
    } finally {
      await bare.cleanup()
    }
  })

  it('bounds the reports it serves', async () => {
    const telemetry = (await call('/api/telemetry'))?.body as { specialists: unknown[]; truncated: number }
    // A report aggregated across every run in the project is the one payload
    // here with no natural end. The cap and the count of what it dropped are
    // both on the wire, so the ceiling is visible rather than silent.
    expect(telemetry.specialists.length).toBeLessThanOrEqual(TELEMETRY_MAX_ROWS)
    expect(telemetry.truncated).toBe(0)
  })

  it('answers for a track this project does not define without describing it', async () => {
    const result = await call('/api/preflight/nonsense')
    expect(result?.status).toBe(404)
    expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
    // A track name is an id everywhere else in the engine, so a name that is
    // not one is refused before anything reads a directory.
    expect((await call('/api/preflight/not a track'))?.status).toBe(400)
    expect((await call('/api/preflight'))?.status).toBe(404)
    expect((await call('/api/preflight/edit/extra'))?.status).toBe(404)
    // The report routes are reads and nothing else.
    expect((await call('/api/telemetry', 'POST'))?.status).toBe(405)
    expect((await call('/api/preflight/edit', 'DELETE'))?.status).toBe(405)
  })

  describe('the roster dry-run door', () => {
    const roster = (candidate: unknown, method = 'GET') =>
      call(`/api/roster/edit/valid?roster=${encodeURIComponent(JSON.stringify(candidate))}`, method)

    it('reports a composition cycleRosterSet would accept, and no violations', async () => {
      // `edit`'s default track (`DEFAULT_TRACKS.edit`) is `required: ['editor',
      // 'verifier'], available: []`, so both required names and nothing to
      // explain is the whole story.
      const result = await roster({ selected: ['editor', 'verifier'], skipped: {} })
      expect(result?.status).toBe(200)
      expect(result?.body).toEqual({ valid: true, violations: [] })
    })

    it('reports a composition it would refuse, with the code and no prose', async () => {
      const result = await roster({ selected: ['editor'], skipped: {} })
      expect(result?.status).toBe(200)
      const body = result?.body as { valid: boolean; violations: { code: string; params?: object }[] }
      expect(body.valid).toBe(false)
      expect(body.violations).toContainEqual({ code: 'roster.required', params: { agent: 'verifier', track: 'edit' } })
      // No sentence anywhere in the payload — every value on the wire is a
      // code or one of that code's named params, never a rendered word.
      expect(JSON.stringify(body)).not.toMatch(/required by track|cannot be dropped/)
    })

    it('defaults to an empty composition when the query is omitted, rather than 400ing', async () => {
      const result = await call('/api/roster/edit/valid')
      expect(result?.status).toBe(200)
      const body = result?.body as { valid: boolean; violations: unknown[] }
      expect(body.valid).toBe(false)
      expect(body.violations.length).toBeGreaterThan(0)
    })

    it('performs no write for a composition it refuses — it only answers', async () => {
      // The confirmation the phase brief asks for, restated as a test: `rosterSet`
      // — the only function that could persist any of this — is not imported
      // anywhere this route's module graph reaches; `tests/web/boundary.test.ts`'s
      // `FORBIDDEN` list is the structural half of that guarantee, and
      // `tests/web/read.test.ts`'s hash-the-tree test is the behavioural half.
      const before = await roster({ selected: [], skipped: {} })
      const after = await roster({ selected: [], skipped: {} })
      expect(after?.body).toEqual(before?.body)
    })

    it('answers 404 for a track this project does not define', async () => {
      const result = await call(
        `/api/roster/nonsense/valid?roster=${encodeURIComponent(JSON.stringify({ selected: [], skipped: {} }))}`,
      )
      expect(result?.status).toBe(404)
      expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
    })

    it('answers 400 for a track id that is not shaped like one, same as the sibling preflight route', async () => {
      expect((await call('/api/roster/not a track/valid'))?.status).toBe(400)
    })

    it('answers 404 rather than 500 for a project with no config at all', async () => {
      const bare = await makeTmpProject()
      try {
        const result = await handleApi(
          bare.dir,
          'GET',
          `/api/roster/edit/valid?roster=${encodeURIComponent(JSON.stringify({ selected: [], skipped: {} }))}`,
        )
        expect(result?.status).toBe(404)
        expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
      } finally {
        await bare.cleanup()
      }
    })

    it('answers 400 for malformed JSON in the query, rather than 500ing', async () => {
      expect((await call('/api/roster/edit/valid?roster=%7Bnot-json'))?.status).toBe(400)
    })

    it('answers 400 for well-formed JSON that does not fit the candidate shape', async () => {
      // `strictObject`, like every wire schema `api.ts` parses: an unknown key
      // is refused rather than silently ignored.
      expect((await roster({ selected: 'editor', skipped: {} }))?.status).toBe(400)
      expect((await roster({ selected: [], skipped: {}, cycle: 1 }))?.status).toBe(400)
    })

    it('answers 404 with no /valid suffix, and 405 for anything but GET', async () => {
      expect((await call('/api/roster/edit'))?.status).toBe(404)
      expect((await roster({ selected: [], skipped: {} }, 'POST'))?.status).toBe(405)
    })
  })

  it('refuses anything that is not a read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('/api/state', method))?.status).toBe(405)
    }
  })

  it('cannot be steered out of .mjloop', async () => {
    // The id shape is itself the traversal guard: `.` is outside `[\w-]`, so
    // `..` cannot match. These are the engine's own schemas doing filesystem
    // duty on the wire.
    const traversals = [
      '/api/plans/../../etc',
      '/api/plans/..%2F..%2Fetc',
      '/api/stories/../../../etc/passwd',
      '/api/stories/../../../etc/passwd/runs',
      '/api/runs/../..',
      '/api/memory/../config.yaml',
      '/api/runs/P001/../../..',
      '/api/preflight/../../etc',
      '/api/preflight/..%2F..%2Fconfig.yaml',
      '/api/telemetry/../../etc',
      '/api/profile/../../etc',
      '/api/profile/..%2F..%2Fconfig.yaml',
      '/api/features/../../etc',
      '/api/features/..%2F..%2Fconfig.yaml',
      '/api/features/F001/../../state.json',
      '/api/transcripts/../../etc',
      '/api/transcripts/..%2F..%2Fconfig.yaml',
      '/api/roster/../../etc/valid',
      '/api/roster/..%2F..%2Fconfig.yaml/valid',
      '/api/runs/../../etc/quality',
      '/api/runs/..%2F..%2Fconfig.yaml/quality',
      // An un-normalised path, which a browser would never send but a raw
      // socket can: it is still ours to refuse rather than to resolve.
      '/api/../app.js',
      '/api/../../package.json',
    ]
    for (const attempt of traversals) {
      const result = await call(attempt)
      expect([400, 404], attempt).toContain(result?.status)
    }
  })

  it('answers an unknown route with a code and nothing else', async () => {
    const result = await call('/api/nope')
    expect(result?.status).toBe(404)
    expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
  })

  it('never puts a parameter on an error', async () => {
    const failures = [
      await call('/api/nope'),
      await call('/api/plans/nonsense'),
      await call('/api/plans/P999'),
      await call('/api/state', 'POST'),
      await call('/api/runs/x/0'),
      await call('/api/runs/nope/skills'),
      await call('/api/preflight/nonsense'),
      await call('/api/preflight/not a track'),
      await call('/api/roster/nonsense/valid'),
      await call('/api/roster/edit/valid?roster=not json'),
      await call('/api/profile/1'),
      await call('/api/features/nonsense'),
      await call('/api/features/F404'),
      await call('/api/transcripts/nonsense'),
      await call('/api/transcripts/20260728T090000-1'),
    ]
    for (const failure of failures) {
      const error = (failure?.body as { error?: Record<string, unknown> }).error ?? {}
      expect(Object.keys(error)).toEqual(['code'])
      expect(WEB_CODES).toContain(error['code'])
    }
  })

  it('is stable enough to be conditional', async () => {
    // A flapping body would make every conditional GET a 200, which is what
    // makes `revisions.cycle` being a tick counter affordable in the first place.
    const first = JSON.stringify((await call('/api/plans/P001'))?.body)
    const second = JSON.stringify((await call('/api/plans/P001'))?.body)
    expect(first).toBe(second)
    expect(etag(first)).toBe(etag(second))
  })
})

describe('/api/runs/:id/quality', () => {
  async function startQualityRun(): Promise<string> {
    const config = await loadConfig(project.dir)
    config.orchestration.quality.mode = 'adaptive'
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    const state = await new StateStore(project.dir).get()
    return runDirName(state)
  }

  it('serves the run quality view, unchanged between calls and with no path on it', async () => {
    const runId = await startQualityRun()

    const first = await call(`/api/runs/${runId}/quality`)
    expect(first?.status).toBe(200)
    expect(first?.body).toMatchObject({ policy: { mode: 'adaptive' }, amendments: [], pendingRequest: null })

    // Conditional-GET affordable for the same reason every other document here
    // is: the body does not flap, so the poll costs one 304.
    const second = await call(`/api/runs/${runId}/quality`)
    const body = JSON.stringify(first?.body)
    expect(etag(body)).toBe(etag(JSON.stringify(second?.body)))
    expect(body).not.toContain(project.dir)
  })

  it('is a 404 for a run with no pin and a 500 for a record it cannot read', async () => {
    const runId = await startQualityRun()
    expect((await call('/api/runs/nope/quality'))?.status).toBe(404)

    await fs.writeFile(
      path.join(project.dir, '.mjloop', 'runs', runId, 'quality-policy.json'),
      'not json at all\n',
      'utf8',
    )
    // The diagnosis goes to the server's own stderr by design; this test is
    // about the wire, so the terminal stays clean.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const failure = await call(`/api/runs/${runId}/quality`)
    stderr.mockRestore()
    expect(failure?.status).toBe(500)
    expect(failure?.body).toEqual({ error: { code: 'error.unreadable' } })
  })

  it('reads and never writes', async () => {
    const runId = await startQualityRun()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call(`/api/runs/${runId}/quality`, method))?.status).toBe(405)
    }
    // No sub-path: a route that took anything beyond the run id would be the
    // first half of one that decided something.
    expect((await call(`/api/runs/${runId}/quality/approve`))?.status).toBe(404)
  })
})

describe('/api/agents', () => {
  // Folded together rather than three separate tests (a user ruling on top of
  // the plan's own test count): project and plugin apart, and a sub-path 404,
  // both checked in the one place that already sets up a project agent.
  it('serves the project agents and the plugin agents apart, and is a 404 for a sub-path', async () => {
    await fs.mkdir(path.join(project.dir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(project.dir, '.claude', 'agents', 'scribe.md'),
      '---\nname: scribe\ndescription: Writes notes.\n---\n\nYou write notes.\n',
      'utf8',
    )
    const result = await call('/api/agents')
    const body = result?.body as { project: { name: string }[]; plugin: { name: string }[] }
    expect(body.project.map((agent) => agent.name)).toEqual(['scribe'])
    // The plugin ships its own, read from the repository this test runs in.
    expect(body.plugin.map((agent) => agent.name)).toContain('verifier')

    expect(await call('/api/agents/scribe')).toEqual({ status: 404, body: { error: { code: 'error.notFound' } } })
  })

  it('never puts an absolute path on the wire', async () => {
    await fs.mkdir(path.join(project.dir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(project.dir, '.claude', 'agents', 'scribe.md'),
      '---\nname: scribe\ndescription: Writes notes.\n---\n\nYou write notes.\n',
      'utf8',
    )
    const result = await call('/api/agents')
    expect(JSON.stringify(result?.body)).not.toContain(project.dir)
  })
})
