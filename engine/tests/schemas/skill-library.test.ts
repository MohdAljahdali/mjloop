import { describe, expect, it } from 'vitest'
import { DigestSchema, SkillPackageSchema } from '../../src/schemas/skill-library.js'

const DIGEST = 'a'.repeat(64)
const IMPORTED_AT = '2026-07-31T09:00:00.000Z'

function skillPackage(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    packageId: 'flutter-widgets',
    digest: DIGEST,
    source: {
      kind: 'github',
      url: 'https://github.com/example/flutter-widgets',
      revision: 'a1b2c3d',
    },
    license: { spdx: 'MIT', file: 'LICENSE' },
    skillName: 'Flutter Widgets',
    description: 'Shared widget kit conventions for the mobile component.',
    tags: ['flutter'],
    dependencies: { executables: [], packages: ['flutter'] },
    audit: { state: 'pending', findings: [], at: null },
    guidance: 'Use the shared widget kit under lib/widgets.',
    importedAt: IMPORTED_AT,
    ...overrides,
  }
}

describe('DigestSchema', () => {
  it('accepts a 64-character lower-case hex string', () => {
    expect(DigestSchema.safeParse(DIGEST).success).toBe(true)
  })

  it('rejects too short, too long, upper-case, and non-hex strings', () => {
    expect(DigestSchema.safeParse('a'.repeat(63)).success).toBe(false)
    expect(DigestSchema.safeParse('a'.repeat(65)).success).toBe(false)
    expect(DigestSchema.safeParse('A'.repeat(64)).success).toBe(false)
    expect(DigestSchema.safeParse('g'.repeat(64)).success).toBe(false)
  })

  it('rejects a path traversal attempt disguised as a digest', () => {
    expect(DigestSchema.safeParse('../../../etc/passwd').success).toBe(false)
  })
})

describe('SkillPackageSchema', () => {
  it('parses a well-formed package', () => {
    const parsed = SkillPackageSchema.parse(skillPackage())
    expect(parsed.packageId).toBe('flutter-widgets')
    expect(parsed.digest).toBe(DIGEST)
    expect(parsed.audit.state).toBe('pending')
  })

  it('requires the source url to be https', () => {
    expect(
      SkillPackageSchema.safeParse(
        skillPackage({ source: { kind: 'github', url: 'http://github.com/example/x', revision: 'a1b2c3d' } }),
      ).success,
    ).toBe(false)
  })

  it('rejects a source kind outside the S02 enum', () => {
    expect(
      SkillPackageSchema.safeParse(
        skillPackage({ source: { kind: 'npm', url: 'https://example.com', revision: 'a1b2c3d' } }),
      ).success,
    ).toBe(false)
  })

  it('rejects an empty revision, the moving-ref case this schema exists to forbid', () => {
    expect(
      SkillPackageSchema.safeParse(
        skillPackage({ source: { kind: 'github', url: 'https://github.com/example/x', revision: '' } }),
      ).success,
    ).toBe(false)
  })

  it('allows a null spdx and a null license file', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ license: { spdx: null, file: null } })).success).toBe(true)
  })

  it('accepts every audit state, defaulting to none in particular — the caller states it explicitly', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ audit: { state: 'pending', findings: [], at: null } })).success).toBe(
      true,
    )
    expect(
      SkillPackageSchema.safeParse(skillPackage({ audit: { state: 'passed', findings: [], at: IMPORTED_AT } })).success,
    ).toBe(true)
    expect(
      SkillPackageSchema.safeParse(
        skillPackage({ audit: { state: 'failed', findings: ['unsigned executable'], at: IMPORTED_AT } }),
      ).success,
    ).toBe(true)
    expect(
      SkillPackageSchema.safeParse(skillPackage({ audit: { state: 'unknown', findings: [], at: null } })).success,
    ).toBe(false)
  })

  it('bounds guidance the same way AcceptedProjectSkill does', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ guidance: 'a'.repeat(4000) })).success).toBe(true)
    expect(SkillPackageSchema.safeParse(skillPackage({ guidance: 'a'.repeat(4001) })).success).toBe(false)
  })

  it('rejects a schema version other than 1', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ schema: 2 })).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ extra: true })).success).toBe(false)
  })

  it('rejects a packageId that would not survive being a directory or filename segment', () => {
    expect(SkillPackageSchema.safeParse(skillPackage({ packageId: '../etc' })).success).toBe(false)
  })
})
