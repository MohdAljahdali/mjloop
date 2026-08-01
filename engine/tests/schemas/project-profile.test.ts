import { describe, expect, it } from 'vitest'
import {
  ProjectComponentSchema,
  ProjectProfileSchema,
  ProposedProfileSchema,
} from '../../src/schemas/project-profile.js'

const GENERATED = '2026-07-31T09:00:00.000Z'
const ACCEPTED = '2026-07-31T09:05:00.000Z'

const COMPONENT = {
  id: 'apps-mobile',
  root: 'apps/mobile',
  technology: 'flutter' as const,
  verification: { test: 'cd apps/mobile && flutter test', lint: null, build: null },
  skillTags: ['flutter'],
}

function proposed(components: unknown[]): unknown {
  return { schema: 1, generatedAt: GENERATED, components, basis: ['apps/mobile/pubspec.yaml'] }
}

function accepted(components: unknown[]): unknown {
  return {
    schema: 1,
    revision: 1,
    generatedAt: GENERATED,
    acceptedAt: ACCEPTED,
    acceptedBy: 'mohd',
    components,
    supersedes: null,
  }
}

describe('ProjectComponentSchema', () => {
  it('parses a component and defaults skillTags to none', () => {
    const parsed = ProjectComponentSchema.parse({ ...COMPONENT, skillTags: undefined })
    expect(parsed.skillTags).toEqual([])
    expect(parsed.root).toBe('apps/mobile')
  })

  it('accepts "." for the project root itself', () => {
    expect(ProjectComponentSchema.parse({ ...COMPONENT, id: 'root', root: '.' }).root).toBe('.')
  })

  it('rejects an absolute root', () => {
    // Every later consumer joins this against the project directory, so an
    // absolute value would resolve outside it entirely.
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, root: '/etc' }).success).toBe(false)
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, root: 'C:/windows' }).success).toBe(false)
  })

  it('rejects a ".." segment anywhere in the root', () => {
    for (const root of ['..', '../sibling', 'apps/../../etc', 'apps/..']) {
      expect(ProjectComponentSchema.safeParse({ ...COMPONENT, root }).success).toBe(false)
    }
  })

  it('rejects a backslash in the root', () => {
    // `apps\..\..\etc` is a traversal on Windows and a single legal filename on
    // POSIX. Refusing the separator outright means the check above cannot be
    // walked around by spelling it the other way.
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, root: 'apps\\mobile' }).success).toBe(false)
  })

  it('rejects an empty segment and a bare "." segment', () => {
    for (const root of ['apps//mobile', './apps', 'apps/./mobile', '']) {
      expect(ProjectComponentSchema.safeParse({ ...COMPONENT, root }).success).toBe(false)
    }
  })

  it('rejects an id that is not filesystem-safe', () => {
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, id: 'apps/mobile' }).success).toBe(false)
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, id: '../escape' }).success).toBe(false)
  })

  it('rejects an unknown technology and an unknown key', () => {
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, technology: 'rails' }).success).toBe(false)
    expect(ProjectComponentSchema.safeParse({ ...COMPONENT, framework: 'flutter' }).success).toBe(false)
  })

  it('rejects an empty verification command rather than storing one', () => {
    expect(
      ProjectComponentSchema.safeParse({ ...COMPONENT, verification: { test: '', lint: null, build: null } }).success,
    ).toBe(false)
  })
})

describe('components array', () => {
  const second = { ...COMPONENT, id: 'services-api', root: 'services/api', technology: 'python' as const }

  it('accepts a sorted array of uniquely identified components', () => {
    expect(ProposedProfileSchema.safeParse(proposed([COMPONENT, second])).success).toBe(true)
    expect(ProjectProfileSchema.safeParse(accepted([COMPONENT, second])).success).toBe(true)
  })

  it('rejects a duplicate component id', () => {
    const duplicate = ProposedProfileSchema.safeParse(proposed([COMPONENT, { ...second, id: COMPONENT.id }]))
    expect(duplicate.success).toBe(false)
    expect(JSON.stringify(duplicate.error?.issues)).toContain('apps-mobile')
    expect(ProjectProfileSchema.safeParse(accepted([COMPONENT, { ...second, id: COMPONENT.id }])).success).toBe(false)
  })

  it('rejects an unsorted components array', () => {
    // Two scans of one tree must produce byte-identical records, and a record
    // whose order is free is a record two equal scans can disagree about.
    expect(ProposedProfileSchema.safeParse(proposed([second, COMPONENT])).success).toBe(false)
    expect(ProjectProfileSchema.safeParse(accepted([second, COMPONENT])).success).toBe(false)
  })

  it('accepts no components at all', () => {
    expect(ProposedProfileSchema.safeParse(proposed([])).success).toBe(true)
  })
})

describe('ProposedProfileSchema', () => {
  it('rejects a schema version it does not know', () => {
    expect(ProposedProfileSchema.safeParse({ ...(proposed([]) as object), schema: 2 }).success).toBe(false)
  })

  it('rejects a generatedAt that is not an ISO timestamp', () => {
    expect(ProposedProfileSchema.safeParse({ ...(proposed([]) as object), generatedAt: 'today' }).success).toBe(false)
  })

  it('rejects an empty basis entry', () => {
    expect(ProposedProfileSchema.safeParse({ ...(proposed([]) as object), basis: [''] }).success).toBe(false)
  })
})

describe('ProjectProfileSchema', () => {
  it('rejects a revision that is not a positive integer', () => {
    for (const revision of [0, -1, 1.5]) {
      expect(ProjectProfileSchema.safeParse({ ...(accepted([]) as object), revision }).success).toBe(false)
    }
  })

  it('records what it supersedes, or null for the first revision', () => {
    expect(ProjectProfileSchema.parse({ ...(accepted([]) as object), revision: 2, supersedes: 1 }).supersedes).toBe(1)
    expect(ProjectProfileSchema.parse(accepted([])).supersedes).toBeNull()
    expect(ProjectProfileSchema.safeParse({ ...(accepted([]) as object), supersedes: 0 }).success).toBe(false)
  })

  it('demands an acceptedBy, because an acceptance nobody made is not one', () => {
    expect(ProjectProfileSchema.safeParse({ ...(accepted([]) as object), acceptedBy: '' }).success).toBe(false)
  })
})
