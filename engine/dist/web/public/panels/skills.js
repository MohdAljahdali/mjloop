/**
 * The component map, the machine's skill library, and what this project has
 * accepted of it.
 *
 * Read-only, and permanently so. Accepting a map or activating a skill changes
 * what every later run is told to use, which is the class of write
 * `web/writes.ts` denies the browser — the same list `runStart` and
 * `cycleAdvance` are on. So this panel reports and offers nothing to press.
 * `mjloop-cli profile accept` and `mjloop-cli skills accept|disable|enable|remove`
 * are where those decisions are made, and a line under each block says so:
 * a read-only surface with no explanation reads as a broken one.
 *
 * The map lived in Config until this panel existed, riding `revisions.config`
 * and `revisions.state` for want of a key of its own. It rides
 * `revisions.profile` now. It moved because it is a *record* rather than a
 * setting, and because it is the thing the skills below it are routed by:
 * a component's `skillTags` and an acceptance's `components` are two halves of
 * one join, and they were two tabs apart.
 */
import { clone, flag, phrase, translateStatic, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { stamp } from '../lib/fmt.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/** @typedef {import('../../read.js').ProfileView} ProfileView */
/** @typedef {import('../../read.js').SkillsView} SkillsView */
/** @typedef {import('../../../schemas/skill-library.js').SkillPackage} SkillPackage */
/** @typedef {import('../../../schemas/skill-acceptance.js').ProjectSkillAcceptance} ProjectSkillAcceptance */

/** The three verification commands a component may declare, in record order. */
const VERIFY_COMMANDS = /** @type {const} */ (['test', 'lint', 'build'])

/** Enough of a digest to recognise, and not so much that it wraps a column. */
const DIGEST_SHOWN = 12

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {string} digest
 * @returns {string}
 */
export function shortDigest(digest) {
  return digest.slice(0, DIGEST_SHOWN)
}

/**
 * Pair every acceptance with the library package it names, or with null.
 *
 * The null is the point. An acceptance stores a digest and never a path, so
 * that a project's record survives being cloned onto another machine — and the
 * cost of that is precisely this case: a repository whose `.mjloop/skills/`
 * names a package the library on *this* machine has never imported. Neither
 * list read alone shows it. `readSkillsView` serves both in one document so
 * that this join can be made client-side rather than being a route that would
 * have to take a digest.
 *
 * @param {SkillsView | null} view
 * @returns {{ acceptance: ProjectSkillAcceptance, pkg: SkillPackage | null }[]}
 */
export function joinAcceptances(view) {
  if (view === null) return []
  const byDigest = new Map(view.packages.map((pkg) => [pkg.digest, pkg]))
  return view.acceptances.map((acceptance) => ({
    acceptance,
    pkg: byDigest.get(acceptance.digest) ?? null,
  }))
}

export function mountSkills() {
  const node = pick('panel-skills')

  const profileRecord = pick('skills-profile-record')
  const profileDrift = pick('skills-profile-drift')
  const profileEmpty = pick('skills-profile-empty')
  const profileHost = pick('skills-profile-list')

  const acceptancesEmpty = pick('skills-acceptances-empty')
  const acceptancesHost = pick('skills-acceptances')
  const libraryEmpty = pick('skills-library-empty')
  const libraryHost = pick('skills-library')
  const unreadableHost = pick('skills-unreadable')

  /** @type {import('../lib/api.js').Feed<ProfileView>} */
  const profile = feed({
    dep: (state) => state.revisions.profile,
    path: () => '/api/profile',
    onChange: () => draw(),
  })

  /** @type {import('../lib/api.js').Feed<SkillsView>} */
  const skills = feed({
    dep: (state) => state.revisions.skills,
    path: () => '/api/skills',
    onChange: () => draw(),
  })

  register({
    id: 'skills',
    node,
    update(state) {
      profile.update(state)
      skills.update(state)

      drawProfile(profile.value(), profile.value() !== null || profile.error() !== null)

      const view = skills.value()
      const joined = joinAcceptances(view)

      // "Nothing accepted" is claimed only once the answer is in — the rule the
      // telemetry table and the map above both follow. An empty library and a
      // project with no acceptances are the state every machine starts in, and
      // saying so before the fetch settles would say it of a project that has
      // twenty.
      flag(acceptancesEmpty, 'hidden', view === null || joined.length > 0)
      phrase(acceptancesEmpty, 'skills.acceptancesNone')
      reconcile(acceptancesHost, joined, (entry) => entry.acceptance.skillId, acceptanceCard)

      const packages = view?.packages ?? []
      flag(libraryEmpty, 'hidden', view === null || packages.length > 0)
      phrase(libraryEmpty, 'skills.libraryNone')
      reconcile(libraryHost, packages, (pkg) => pkg.digest, packageCard)

      reconcile(unreadableHost, view?.unreadable ?? [], (entry) => entry.digest, unreadableRow)
    },
  })

  /**
   * @param {ProfileView | null} view
   * @param {boolean} answered Whether the fetch has settled, one way or another.
   */
  function drawProfile(view, answered) {
    const revision = view === null ? null : view.revision
    flag(profileRecord, 'hidden', revision === null)
    if (view !== null && revision !== null) {
      phrase(profileRecord, 'config.profileRecord', {
        revision,
        by: view.acceptedBy ?? '',
        // Through `stamp()` like every other instant this page prints. It
        // arrived here as a raw ISO string when the block lived in Config,
        // where it was the only timestamp on the tab and had nothing to look
        // inconsistent beside. It is now three lines above a brief's `Raised`
        // date, which is formatted.
        at: view.acceptedAt === null ? '' : stamp(view.acceptedAt),
      })
    }

    // Only once an accepted map is on screen for it to disagree with. Before
    // that the empty line already says nothing is accepted, and two sentences
    // about one absence is one too many.
    const drift = view !== null && revision !== null && view.proposalDiffers
    flag(profileDrift, 'hidden', !drift)
    if (view !== null && drift) {
      phrase(profileDrift, 'config.profileDrift', { at: view.proposedAt === null ? '' : stamp(view.proposedAt) })
    }

    // A 404 *is* an answer here — it is what a project nothing has ever mapped
    // returns — and it arrives as a failure rather than as a body, so the
    // settled check has to consider both.
    flag(profileEmpty, 'hidden', revision !== null || !answered)
    if (revision === null) phrase(profileEmpty, 'config.profileNone')

    reconcile(profileHost, view?.components ?? [], (component) => component.id, componentCard)
  }

  /* ── row factories ─────────────────────────────────────────────────────── */

  function componentCard() {
    const { root, slots } = clone('tpl-component')
    return {
      root,
      /** @param {ProfileView['components'][number]} component */
      update(component) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, component.id)
        const componentRoot = slots['root']
        if (componentRoot !== undefined) verbatim(componentRoot, component.root)
        const technology = slots['technology']
        if (technology !== undefined) verbatim(technology, component.technology)

        for (const slot of VERIFY_COMMANDS) {
          const cell = slots[slot]
          if (cell === undefined) continue
          // Unset names the check that will not run for this component, which is
          // worth a sentence rather than a blank cell.
          const command = component.verification[slot]
          if (command === null) phrase(cell, 'config.verifyUnset')
          else verbatim(cell, command)
        }

        const tags = slots['tags']
        // The join the acceptances below are selected on. One cell, because the
        // tags are read as a set and a chip list would imply each is actionable.
        if (tags !== undefined) verbatim(tags, component.skillTags.join(' '))

        translateStatic(root)
      },
    }
  }

  function packageCard() {
    const { root, slots } = clone('tpl-package')
    return {
      root,
      /** @param {SkillPackage} pkg */
      update(pkg) {
        const name = slots['name']
        if (name !== undefined) verbatim(name, pkg.skillName)
        const description = slots['description']
        if (description !== undefined) verbatim(description, pkg.description)
        const packageId = slots['packageId']
        if (packageId !== undefined) verbatim(packageId, pkg.packageId)
        const digest = slots['digest']
        if (digest !== undefined) verbatim(digest, shortDigest(pkg.digest))

        // The url, not the kind alone: "github" does not tell you *which*
        // repository these bytes came from, and this is a supply-chain record.
        const source = slots['source']
        if (source !== undefined) verbatim(source, pkg.source.url)
        const revision = slots['revision']
        if (revision !== undefined) verbatim(revision, pkg.source.revision)

        const license = slots['license']
        if (license !== undefined) {
          // A package with no SPDX identifier is the case worth naming: it is a
          // package nobody can tell you the terms of.
          if (pkg.license.spdx === null) phrase(license, 'skills.licenseUnknown')
          else verbatim(license, pkg.license.spdx)
        }

        const audit = slots['audit']
        if (audit !== undefined) phrase(audit, `skills.audit.${pkg.audit.state}`)

        const executables = slots['executables']
        if (executables !== undefined) {
          // Declared, never resolved. The package says it wants these; nothing
          // here has looked for them on this machine.
          if (pkg.dependencies.executables.length === 0) phrase(executables, 'skills.none')
          else verbatim(executables, pkg.dependencies.executables.join(' '))
        }
        const packages = slots['packages']
        if (packages !== undefined) {
          if (pkg.dependencies.packages.length === 0) phrase(packages, 'skills.none')
          else verbatim(packages, pkg.dependencies.packages.join(' '))
        }

        const tags = slots['tags']
        if (tags !== undefined) verbatim(tags, pkg.tags.join(' '))
        const imported = slots['imported']
        if (imported !== undefined) verbatim(imported, stamp(pkg.importedAt))

        // Inspection's findings *and* the sandbox outcome: `writePackage` is
        // only ever reached from a passed audit, so there is no separate import
        // report to draw beside this list (`read.ts:199`).
        const findings = slots['findings']
        if (findings !== undefined) {
          reconcile(findings, pkg.audit.findings, (line) => line, () => {
            const row = clone('tpl-acceptance')
            return {
              root: row.root,
              /** @param {string} line */
              update(line) {
                verbatim(row.slots['text'] ?? row.root, line)
              },
            }
          })
        }

        translateStatic(root)
      },
    }
  }

  function acceptanceCard() {
    const { root, slots } = clone('tpl-acceptance-record')
    return {
      root,
      /** @param {{ acceptance: ProjectSkillAcceptance, pkg: SkillPackage | null }} entry */
      update(entry) {
        const { acceptance, pkg } = entry

        const skillId = slots['skillId']
        if (skillId !== undefined) verbatim(skillId, acceptance.skillId)

        // The one thing a reader cannot work out from either list on its own.
        const missing = slots['missing']
        if (missing !== undefined) {
          flag(missing, 'hidden', pkg !== null)
          if (pkg === null) phrase(missing, 'skills.packageMissing', { digest: shortDigest(acceptance.digest) })
        }

        const packageId = slots['packageId']
        if (packageId !== undefined) verbatim(packageId, acceptance.packageId)
        const digest = slots['digest']
        if (digest !== undefined) verbatim(digest, shortDigest(acceptance.digest))

        const status = slots['status']
        if (status !== undefined) phrase(status, `skills.state.${acceptance.status}`)
        const compatible = slots['compatible']
        if (compatible !== undefined) {
          phrase(compatible, acceptance.compatible ? 'skills.compatibleYes' : 'skills.compatibleNo')
        }

        const components = slots['components']
        if (components !== undefined) {
          // An acceptance enabling no component selects nothing, whatever else
          // it says. That is a sentence, not an empty cell.
          if (acceptance.components.length === 0) phrase(components, 'skills.none')
          else verbatim(components, acceptance.components.join(' '))
        }
        const agents = slots['agents']
        if (agents !== undefined) verbatim(agents, acceptance.agents.join(' '))
        const tags = slots['tags']
        if (tags !== undefined) verbatim(tags, acceptance.tags.join(' '))
        const updatePolicy = slots['updatePolicy']
        if (updatePolicy !== undefined) phrase(updatePolicy, `skills.update.${acceptance.updatePolicy}`)

        const acceptedBy = slots['acceptedBy']
        if (acceptedBy !== undefined) {
          phrase(acceptedBy, 'skills.acceptedRecord', {
            by: acceptance.acceptedBy,
            at: stamp(acceptance.acceptedAt),
          })
        }

        translateStatic(root)
      },
    }
  }

  function unreadableRow() {
    const { root, slots } = clone('tpl-unreadable')
    return {
      root,
      /** @param {SkillsView['unreadable'][number]} entry */
      update(entry) {
        const digest = slots['digest']
        if (digest !== undefined) verbatim(digest, shortDigest(entry.digest))
        // The store's own diagnosis, and engine-authored. It stays verbatim
        // rather than being turned into a key this page would have to keep in
        // step with a message it does not own.
        const reason = slots['reason']
        if (reason !== undefined) verbatim(reason, entry.reason)
      },
    }
  }
}
