import path from 'node:path'
import { ManifestSchema, type Manifest } from '../schemas/plan.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { listStories, readPlan } from '../store/plan-store.js'
import type { Clock } from '../store/state-store.js'

export function manifestPath(planDir: string): string {
  return path.join(planDir, 'manifest.json')
}

/**
 * Rebuild `manifest.json` from the story files.
 *
 * The manifest is an index, not a record: it is regenerated whole every time
 * rather than patched, so it cannot drift from the stories it describes and a
 * corrupt one costs nothing — the next call replaces it. This is the same
 * relationship `INDEX.md` has to the manifests, one level down.
 */
export async function renderManifest(
  projectDir: string,
  planId: string,
  now: Clock = () => new Date(),
): Promise<Manifest> {
  const plan = await readPlan(projectDir, planId)
  const stories = await listStories(projectDir, planId)

  const manifest = ManifestSchema.parse({
    schema: 1,
    plan: plan.frontmatter.id,
    slug: plan.frontmatter.slug,
    title: plan.frontmatter.title,
    generated_at: now().toISOString(),
    stories: stories.map((story) => ({
      id: story.frontmatter.id,
      title: story.frontmatter.title,
      status: story.frontmatter.status,
      ui: story.frontmatter.ui,
      depends_on: story.frontmatter.depends_on,
      file: path.relative(plan.dir, story.file),
    })),
  })

  // backup:false — a derived file has nothing worth restoring, and a `.bak`
  // beside it would only invite someone to treat the stale copy as data.
  await writeJsonAtomic(manifestPath(plan.dir), manifest, { backup: false })
  return manifest
}
