# خطة تنفيذ تبويبَي الوكلاء والمسارات

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** إضافة تبويبَين إلى لوحة `mjloop web` — «الوكلاء» لإدارة `.claude/agents/*.md` وربط المهارات بهم، و«المسارات» لتحرير `tracks:` كمخطّط Vue Flow — مع أمرٍ عام `/mjloop:run` يجعل مساراً جديداً قابلاً للتشغيل.

**Architecture:** طبقة تخزين جديدة `store/agent-store.ts` تعامل ملفّ الوكيل كمستندٍ مبهم (فرونتماتر + جسم) ولا تعرف معنى أي اسم؛ مسار قراءة `/api/agents` يركب على `revisions.agents` كبقيّة التبويبات؛ وأربعة أبواب كتابة جديدة في `web/writes.ts` من صنف `config.patch` — compare-and-swap على بصمة sha256 داخل قفل المخزن. تبويب المسارات يعيد استخدام مسودّة الإعداد ومنطق `lib/config.ts` القائم، ويضيف عليه طبقة رسم مشتقّة لا تُحفظ.

**Tech Stack:** TypeScript، Vue 3.5 (SFC + `<script setup>`)، Vite 7، Vitest 4 + happy-dom + `@vue/test-utils`، Zod 4، `yaml`، و`@vue/flow-core` (إضافة جديدة: `@vue-flow/core`).

**المواصفة:** `docs/superpowers/specs/2026-08-03-web-agents-tracks-design.md`

## Global Constraints

- **المحرّك لا يعرف أسماء الوكلاء.** لا يجوز أن يظهر اسم وكيلٍ بعينه (`builder`، `verifier`، …) في منطق تنسيق. `store/agent-store.ts` يتعامل مع الملف كمستندٍ مبهم.
- **`FORBIDDEN` في `tests/web/boundary.test.ts` لا يُنقص منه بندٌ واحد.** `runStart` و`rosterSet` و`runLog` و`cycleAdvance` تبقى ممنوعة تحت `src/web/`.
- **لا نثر على السلك.** كل رسالة من الخادم `{ code, params }`، والرمز عضوٌ في `WEB_CODES` (`src/web/codes.ts`). `error.message` لا يعبر السلك أبداً؛ التشخيص إلى `process.stderr`.
- **كل مفتاح لغة يُضاف إلى `en.json` و`ar.json` معاً**، بنفس الترتيب، وفضاء اسمه مذكور في `NAMESPACES` بـ `tests/web/locales.test.ts`.
- **لا فواصل منقوطة** في نهايات الجُمل؛ الأسلوب القائم في المستودع (`prettier`-less، بلا `;`).
- **التعليقات تشرح القرار لا الآلية.** هذا المستودع يوثّق «لماذا رُفض البديل»؛ اتّبع النبرة القائمة في الملف الذي تعدّله.
- **أوامر التحقّق**: `cd engine && npm test` و`cd engine && npm run typecheck` و`cd engine && npm run build`. تُشغَّل من جذر المستودع.
- **اقتصاد الاختبارات (قرار المستخدم، يعلو على تعداد الحالات في نصّ كل مهمّة).** كتل الاختبار في المهام هي **سقفٌ لا حصّة**: نفّذ منها الحالات التي تحرس حدّاً أو رفضاً — البصمة البائتة، الاسم المرفوض، الحجب، الاستخدام في مسار، التشغيلة النشطة، الدورة في المخطّط — واطوِ ما تبقّى من حالات «الحالة السعيدة» المتشابهة في اختبارٍ واحد. **أربعة اختبارات لكل مهمّة حدٌّ أعلى معقول.** اختبارٌ مطويّ ليس اختباراً مفقوداً: الحارس هو ما يُختبَر، والباقي يثبته `typecheck`. لا تُسقط حالة رفضٍ أبداً بحجّة الاقتصاد.
- **الالتزام بعد كل مهمّة**، برسالة `<type>(scope): …` تنتهي بسطر `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **`dist/` ملتزَمة في git**، لكنها تُبنى في مهمّة واحدة فقط (المهمّة 12) لا بعد كل مهمّة.

## بنية الملفّات

**تُنشأ:**

| الملف | مسؤوليته |
|---|---|
| `engine/src/store/agent-store.ts` | قراءة وكتابة وحذف ملفّات الوكلاء، بالبصمة وبالحصر بالاسم |
| `engine/src/web/app/lib/agents.ts` | منطق المتصفّح النقي: «أين يُستخدَم هذا الوكيل»، وكشف عقد المخرجات |
| `engine/src/web/app/lib/trackgraph.ts` | الطبقات الطوبولوجية وكشف الدورة، لوضع عقد المخطّط |
| `engine/src/web/app/panels/Agents.vue` | تبويب الوكلاء |
| `engine/src/web/app/panels/Tracks.vue` | تبويب المسارات، بمنظورَيه |
| `engine/src/web/app/components/AgentCard.vue` | بطاقة وكيل واحد: الرأس، الاستخدام، المهارات |
| `engine/src/web/app/components/AgentEditor.vue` | محرّر الفرونتماتر والجسم |
| `engine/src/web/app/components/AgentSkillRow.vue` | صفّ مهارة مقبولة على بطاقة وكيل |
| `engine/src/web/app/components/TrackGraph.vue` | لوحة Vue Flow |
| `engine/src/web/app/components/TrackRunForm.vue` | نموذج تشغيل المسار |
| `engine/src/web/app/styles/70-graph.css` | أنماط المخطّط والبطاقات |
| `commands/run.md` | الأمر العام `/mjloop:run` |

**تُعدَّل:**

| الملف | التعديل |
|---|---|
| `engine/src/web/revision.ts` | مفتاح `agents` |
| `engine/src/web/protocol.ts` | `Revisions.agents`، وأنواع عرض الوكلاء |
| `engine/src/web/read.ts` | `readAgentsView` |
| `engine/src/web/api.ts` | مسار `agents` |
| `engine/src/web/codes.ts` | خمسة رموز جديدة |
| `engine/src/web/writes.ts` | أربعة أبواب جديدة |
| `engine/src/store/skill-acceptance-store.ts` | `setAcceptanceAgents` وتوسيع الأدوار |
| `engine/src/schemas/skill-acceptance.ts` | توسيع الأدوار |
| `engine/src/ops/run.ts` | توسيع الأدوار |
| `engine/src/web/app/lib/config.ts` | فصل `collectSettingsChanges` / `collectTrackChanges` |
| `engine/src/web/app/lib/stories.ts` | توسيع الأدوار في المتصفّح |
| `engine/src/web/app/panels/Config.vue` | إخراج `TrackEditors` |
| `engine/src/web/app/composables/useTabs.ts` | تبويبان جديدان |
| `engine/src/web/app/App.vue` | تركيب اللوحتين |
| `engine/src/web/app/locales/en.json`, `ar.json` | المفاتيح الجديدة |
| `engine/package.json` | `@vue-flow/core` |
| `skills/mjloop-leader/SKILL.md` | قسم المسار بلا أمرٍ باسمه |
| `tests/web/boundary.test.ts` | توسيع قائمة الاستيرادات المسموحة |
| `tests/web/locales.test.ts` | فضاءا الاسم `agents` و`tracks` |

---

### Task 1: مخزن الوكلاء — القراءة والبصمة

**Files:**
- Create: `engine/src/store/agent-store.ts`
- Test: `engine/tests/store/agent-store.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`, `serialiseFrontmatter` من `src/store/frontmatter.js`؛ `AgentNameSchema` من `src/schemas/contract.js`
- Produces:
  ```ts
  export interface AgentDoc {
    name: string
    source: 'project' | 'plugin'
    description: string
    tools: string | null
    model: string | null
    extra: Record<string, unknown>
    body: string
    digest: string
    path: string
  }
  export interface UnreadableAgent { path: string }
  export function agentDigest(raw: string): string
  export function projectAgentsDir(projectDir: string): string
  export async function listAgents(dir: string, source: 'project' | 'plugin'): Promise<{ agents: AgentDoc[]; unreadable: UnreadableAgent[] }>
  export async function readAgent(projectDir: string, name: string): Promise<AgentDoc | null>
  ```

- [ ] **Step 1: اكتب الاختبار الفاشل**

`engine/tests/store/agent-store.test.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentDigest, listAgents, projectAgentsDir, readAgent } from '../../src/store/agent-store.js'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-agents-'))
  await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, '.claude', 'agents', `${name}.md`), body, 'utf8')
}

const SAMPLE = `---
name: scribe
description: Writes notes.
tools: Read, Write
model: sonnet
color: blue
---

You write notes. You never edit code.
`

describe('reading agent files', () => {
  it('reads the frontmatter, the body and a digest', async () => {
    await write('scribe', SAMPLE)
    const doc = await readAgent(dir, 'scribe')
    expect(doc?.name).toBe('scribe')
    expect(doc?.description).toBe('Writes notes.')
    expect(doc?.tools).toBe('Read, Write')
    expect(doc?.model).toBe('sonnet')
    expect(doc?.body).toBe('You write notes. You never edit code.')
    expect(doc?.source).toBe('project')
    expect(doc?.digest).toBe(agentDigest(SAMPLE))
  })

  it('keeps a frontmatter field it does not know about', async () => {
    // Dropping it would mean saving from the dashboard silently erases what a
    // person wrote by hand.
    await write('scribe', SAMPLE)
    const doc = await readAgent(dir, 'scribe')
    expect(doc?.extra).toEqual({ color: 'blue' })
  })

  it('answers null for an agent that is not there', async () => {
    expect(await readAgent(dir, 'nobody')).toBeNull()
  })

  it('reports an unparseable file rather than dropping it', async () => {
    await write('broken', 'no frontmatter at all\n')
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents).toEqual([])
    expect(listing.unreadable).toEqual([{ path: path.join(projectAgentsDir(dir), 'broken.md') }])
  })

  it('lists in name order and ignores non-markdown entries', async () => {
    await write('zulu', SAMPLE.replace('scribe', 'zulu'))
    await write('alpha', SAMPLE.replace('scribe', 'alpha'))
    await fs.writeFile(path.join(dir, '.claude', 'agents', 'notes.txt'), 'ignored', 'utf8')
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents.map((agent) => agent.name)).toEqual(['alpha', 'zulu'])
  })

  it('answers an empty listing for a directory that does not exist', async () => {
    const listing = await listAgents(path.join(dir, 'nowhere'), 'project')
    expect(listing).toEqual({ agents: [], unreadable: [] })
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/store/agent-store.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/agent-store.js'`

- [ ] **Step 3: اكتب أقلّ تنفيذ يُنجح الاختبار**

`engine/src/store/agent-store.ts`:

```ts
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'

/**
 * One agent file, as a document this layer does not interpret.
 *
 * The engine does not know agent names — that is the rule the whole track
 * design rests on (see the `mjloop-extend` skill). So nothing here branches on
 * a name, and `extra` exists so a field this layer has never heard of survives
 * a round trip: dropping it would mean saving from the dashboard silently
 * erases what somebody wrote by hand.
 */
export interface AgentDoc {
  name: string
  source: 'project' | 'plugin'
  description: string
  tools: string | null
  model: string | null
  extra: Record<string, unknown>
  body: string
  digest: string
  path: string
}

export interface UnreadableAgent {
  path: string
}

/** sha256 over the file's own bytes — the same shape, and the same job, as `configRevision`. */
export function agentDigest(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * `.claude/agents/`, and nowhere else.
 *
 * Claude Code reads project subagents from this directory and from no other,
 * whatever a config might suggest — `schemas/config.ts:490-491` records the
 * same fact against a `custom_dirs` setting that used to claim otherwise.
 */
export function projectAgentsDir(projectDir: string): string {
  return path.join(projectDir, '.claude', 'agents')
}

const KNOWN = ['name', 'description', 'tools', 'model'] as const

function toDoc(name: string, raw: string, file: string, source: 'project' | 'plugin'): AgentDoc {
  const { data, body } = parseFrontmatter(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('frontmatter is not a mapping')
  }
  const record = data as Record<string, unknown>
  const text = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => !KNOWN.includes(key as (typeof KNOWN)[number])),
  )
  return {
    // The filename wins over a `name:` that disagrees with it: the filename is
    // what Claude Code dispatches on, so trusting the field would show a name
    // no track can ever draft.
    name,
    source,
    description: text('description') ?? '',
    tools: text('tools'),
    model: text('model'),
    extra,
    body,
    digest: agentDigest(raw),
    path: file,
  }
}

export async function listAgents(
  dir: string,
  source: 'project' | 'plugin',
): Promise<{ agents: AgentDoc[]; unreadable: UnreadableAgent[] }> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort()
  } catch {
    // A project with no `.claude/agents/` is the ordinary case, not a fault.
    return { agents: [], unreadable: [] }
  }
  const agents: AgentDoc[] = []
  const unreadable: UnreadableAgent[] = []
  for (const entry of names) {
    const file = path.join(dir, entry)
    try {
      agents.push(toDoc(entry.slice(0, -3), await fs.readFile(file, 'utf8'), file, source))
    } catch {
      // Reported rather than dropped: a file that vanishes from the list is a
      // file nobody knows is broken.
      unreadable.push({ path: file })
    }
  }
  return { agents, unreadable }
}

export async function readAgent(projectDir: string, name: string): Promise<AgentDoc | null> {
  const file = path.join(projectAgentsDir(projectDir), `${name}.md`)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  return toDoc(name, raw, file, 'project')
}
```

- [ ] **Step 4: شغّل الاختبار وتأكّد من نجاحه**

Run: `cd engine && npx vitest run tests/store/agent-store.test.ts`
Expected: PASS — ستّة اختبارات

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/store/agent-store.ts engine/tests/store/agent-store.test.ts
git commit -m "feat(store): read agent files as opaque documents

Frontmatter, body and a sha256 of the file's own bytes. Nothing here
branches on an agent's name: the engine not knowing them is what makes a
track data rather than code.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: مخزن الوكلاء — الكتابة والحذف بالحرس

**Files:**
- Modify: `engine/src/store/agent-store.ts`
- Test: `engine/tests/store/agent-store.test.ts` (يُضاف إليه)

**Interfaces:**
- Consumes: `AgentDoc`, `agentDigest`, `projectAgentsDir` من المهمّة 1؛ `serialiseFrontmatter` من `src/store/frontmatter.js`؛ `writeTextAtomic` من `src/store/atomic.js`؛ `withLock` من `src/store/lock.js`؛ `resolveLoopPaths` من `src/store/paths.js`
- Produces:
  ```ts
  export type AgentWriteFailure = 'stale' | 'exists' | 'missing' | 'invalid' | 'reserved'
  export class AgentWriteError extends Error { readonly kind: AgentWriteFailure }
  export interface AgentInput {
    name: string
    description: string
    tools: string | null
    model: string | null
    extra: Record<string, unknown>
    body: string
  }
  export async function writeAgent(projectDir: string, input: AgentInput, options: { expectDigest: string | null; reserved: readonly string[] }): Promise<{ digest: string }>
  export async function deleteAgent(projectDir: string, name: string, expectDigest: string): Promise<void>
  ```

`expectDigest: null` تعني «أنشئ»، وقيمةٌ نصّية تعني «استبدل هذه البصمة بالذات».

- [ ] **Step 1: اكتب الاختبار الفاشل**

يُضاف إلى `engine/tests/store/agent-store.test.ts`:

```ts
import { AgentWriteError, deleteAgent, writeAgent } from '../../src/store/agent-store.js'

const INPUT = {
  name: 'scribe',
  description: 'Writes notes.',
  tools: 'Read, Write',
  model: 'sonnet',
  extra: {},
  body: 'You write notes.',
}

describe('writing agent files', () => {
  it('creates a file and answers its digest', async () => {
    const { digest } = await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    const doc = await readAgent(dir, 'scribe')
    expect(doc?.digest).toBe(digest)
    expect(doc?.body).toBe('You write notes.')
  })

  it('refuses to create over a file that is already there', async () => {
    await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    await expect(writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })).rejects.toMatchObject({ kind: 'exists' })
  })

  it('refuses an update whose digest has moved underneath it', async () => {
    await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    await expect(
      writeAgent(dir, { ...INPUT, body: 'edited' }, { expectDigest: agentDigest('something else'), reserved: [] }),
    ).rejects.toMatchObject({ kind: 'stale' })
    // And the refusal changed nothing on disk.
    expect((await readAgent(dir, 'scribe'))?.body).toBe('You write notes.')
  })

  it('refuses a name that would shadow a plugin agent', async () => {
    await expect(
      writeAgent(dir, { ...INPUT, name: 'verifier' }, { expectDigest: null, reserved: ['verifier'] }),
    ).rejects.toMatchObject({ kind: 'reserved' })
  })

  it.each(['../escape', 'a/b', '.', '..', '', 'Has Space', 'a--b'])('refuses the name %j', async (name) => {
    await expect(writeAgent(dir, { ...INPUT, name }, { expectDigest: null, reserved: [] })).rejects.toMatchObject({
      kind: 'invalid',
    })
    // Nothing was written anywhere.
    const listing = await listAgents(projectAgentsDir(dir), 'project')
    expect(listing.agents).toEqual([])
  })

  it('keeps an unknown frontmatter field through a round trip', async () => {
    await writeAgent(dir, { ...INPUT, extra: { color: 'blue' } }, { expectDigest: null, reserved: [] })
    expect((await readAgent(dir, 'scribe'))?.extra).toEqual({ color: 'blue' })
  })

  it('deletes only the digest it was shown', async () => {
    const { digest } = await writeAgent(dir, INPUT, { expectDigest: null, reserved: [] })
    await expect(deleteAgent(dir, 'scribe', agentDigest('stale'))).rejects.toMatchObject({ kind: 'stale' })
    expect(await readAgent(dir, 'scribe')).not.toBeNull()
    await deleteAgent(dir, 'scribe', digest)
    expect(await readAgent(dir, 'scribe')).toBeNull()
  })

  it('refuses to delete an agent that is not there', async () => {
    await expect(deleteAgent(dir, 'ghost', agentDigest('x'))).rejects.toMatchObject({ kind: 'missing' })
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/store/agent-store.test.ts`
Expected: FAIL — `writeAgent is not a function`

- [ ] **Step 3: اكتب التنفيذ**

يُضاف إلى `engine/src/store/agent-store.ts`:

```ts
import { AgentNameSchema } from '../schemas/contract.js'
import { serialiseFrontmatter } from './frontmatter.js'
import { writeTextAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'

export type AgentWriteFailure = 'stale' | 'exists' | 'missing' | 'invalid' | 'reserved'

export class AgentWriteError extends Error {
  constructor(readonly kind: AgentWriteFailure, message: string) {
    super(message)
    this.name = 'AgentWriteError'
  }
}

export interface AgentInput {
  name: string
  description: string
  tools: string | null
  model: string | null
  extra: Record<string, unknown>
  body: string
}

/**
 * The whole path defence, in one place.
 *
 * The name is a token to be matched, never a path to be opened: it goes
 * through `AgentNameSchema` — the engine's own — and only then is it joined
 * onto the agents directory. `.` and `/` are outside that schema's character
 * class, so `..` and `a/b` cannot match, and this is the first write in the
 * server that lands outside `.mjloop/`.
 */
function agentFile(projectDir: string, name: string): string {
  if (!AgentNameSchema.safeParse(name).success) {
    throw new AgentWriteError('invalid', 'not an agent name')
  }
  return path.join(projectAgentsDir(projectDir), `${name}.md`)
}

function document(input: AgentInput): string {
  // Insertion order is the serialised order, and it matches what every agent
  // file in this plugin already opens with — a diff against a hand-written
  // file should be about what changed, not about four fields moving.
  const data: Record<string, unknown> = { name: input.name, description: input.description }
  if (input.tools !== null) data['tools'] = input.tools
  if (input.model !== null) data['model'] = input.model
  Object.assign(data, input.extra)
  return serialiseFrontmatter(data, input.body)
}

/**
 * @param options.expectDigest `null` creates; a digest replaces exactly that
 *   revision of the file and refuses anything else. A stale click is refused
 *   rather than obeyed — the same contract `mutateConfig` holds.
 * @param options.reserved The plugin's own agent names. A project agent
 *   shadows a plugin one of the same name, so this refuses to replace an agent
 *   carrying a system invariant with whatever somebody typed.
 */
export async function writeAgent(
  projectDir: string,
  input: AgentInput,
  options: { expectDigest: string | null; reserved: readonly string[] },
): Promise<{ digest: string }> {
  const file = agentFile(projectDir, input.name)
  if (options.reserved.includes(input.name)) {
    throw new AgentWriteError('reserved', 'that name shadows a plugin agent')
  }
  if (input.description.trim().length === 0) {
    throw new AgentWriteError('invalid', 'an agent needs a description')
  }

  // The project lock, not a lock of this file's own: an agent write and a
  // config write are two halves of one decision often enough — deleting an
  // agent a track names is refused by reading that config — that serialising
  // them against each other is worth more than the concurrency it costs.
  return withLock(resolveLoopPaths(projectDir).lock, async () => {
    let current: string | null = null
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      current = null
    }
    if (options.expectDigest === null && current !== null) {
      throw new AgentWriteError('exists', 'that agent already exists')
    }
    if (options.expectDigest !== null) {
      if (current === null) throw new AgentWriteError('missing', 'that agent is gone')
      if (agentDigest(current) !== options.expectDigest) {
        throw new AgentWriteError('stale', 'the file moved underneath the editor')
      }
    }
    const next = document(input)
    await fs.mkdir(projectAgentsDir(projectDir), { recursive: true })
    await writeTextAtomic(file, next)
    return { digest: agentDigest(next) }
  })
}

export async function deleteAgent(projectDir: string, name: string, expectDigest: string): Promise<void> {
  const file = agentFile(projectDir, name)
  await withLock(resolveLoopPaths(projectDir).lock, async () => {
    let current: string
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      throw new AgentWriteError('missing', 'that agent is gone')
    }
    if (agentDigest(current) !== expectDigest) {
      throw new AgentWriteError('stale', 'the file moved underneath the editor')
    }
    await fs.rm(file)
  })
}
```

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npx vitest run tests/store/agent-store.test.ts && npm run typecheck`
Expected: PASS، و`typecheck` نظيف

> ملاحظة: `withLock` يحتاج `.mjloop/` موجوداً. أضف إلى `beforeEach` في الاختبار:
> `await fs.mkdir(path.join(dir, '.mjloop'), { recursive: true })` — وإن رفض `resolveLoopPaths` مشروعاً غير مهيّأ، اقرأ `src/store/paths.ts` واتبع ما تفعله `tests/store/config-mutation.test.ts` في تهيئة مشروعها المؤقّت، ولا تخترع تهيئةً ثانية.

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/store/agent-store.ts engine/tests/store/agent-store.test.ts
git commit -m "feat(store): guarded writes for agent files

Compare-and-swap on the file's own sha256, inside the project lock, with
the name confined by AgentNameSchema before it is ever joined onto a path.
This is the first write the server makes outside .mjloop/, so the name is a
token that is matched and never a path that is opened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: تغذية `/api/agents` ومفتاح المراجعة

**Files:**
- Modify: `engine/src/web/revision.ts`, `engine/src/web/protocol.ts`, `engine/src/web/read.ts`, `engine/src/web/api.ts`
- Modify: `engine/tests/web/helpers/page.ts` (قيمة `agents` الصفرية في `emptySnapshot`)
- Test: `engine/tests/web/api.test.ts` (يُضاف إليه)، `engine/tests/web/snapshot.test.ts` (يُضاف إليه)

**Interfaces:**
- Consumes: `listAgents`, `projectAgentsDir` من المهمّة 1
- Produces:
  ```ts
  // protocol.ts
  export interface AgentView {
    name: string
    source: 'project' | 'plugin'
    description: string
    tools: string | null
    model: string | null
    extra: Record<string, unknown>
    body: string
    digest: string
  }
  export interface AgentsView {
    project: AgentView[]
    plugin: AgentView[]
    unreadable: { path: string }[]
  }
  // Revisions gains: agents: string
  // read.ts
  export async function readAgentsView(projectDir: string): Promise<AgentsView>
  export const PLUGIN_AGENTS_DIR: string
  ```

`AgentView` تُسقط `path` من `AgentDoc` عمداً: مسارٌ مطلق على السلك هو ما لا يحتاجه المتصفّح ولا يجوز أن يعرضه.

- [ ] **Step 1: اكتب الاختبارات الفاشلة**

يُضاف إلى `engine/tests/web/api.test.ts` (اتبع ما يفعله الملف من تهيئة مشروع مؤقّت):

```ts
describe('/api/agents', () => {
  it('serves the project agents and the plugin agents apart', async () => {
    await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(dir, '.claude', 'agents', 'scribe.md'),
      '---\nname: scribe\ndescription: Writes notes.\n---\n\nYou write notes.\n',
      'utf8',
    )
    const result = await handleApi(dir, 'GET', '/api/agents')
    const body = result?.body as { project: { name: string }[]; plugin: { name: string }[] }
    expect(body.project.map((agent) => agent.name)).toEqual(['scribe'])
    // The plugin ships its own, read from the repository this test runs in.
    expect(body.plugin.map((agent) => agent.name)).toContain('verifier')
  })

  it('never puts an absolute path on the wire', async () => {
    const result = await handleApi(dir, 'GET', '/api/agents')
    expect(JSON.stringify(result?.body)).not.toContain(dir)
  })

  it('is a 404 for a sub-path', async () => {
    expect(await handleApi(dir, 'GET', '/api/agents/scribe')).toEqual({ status: 404, body: { error: { code: 'error.notFound' } } })
  })
})
```

يُضاف إلى `engine/tests/web/snapshot.test.ts`:

```ts
it('moves the agents revision when an agent file is edited in place', async () => {
  await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
  const file = path.join(dir, '.claude', 'agents', 'scribe.md')
  await fs.writeFile(file, '---\nname: scribe\ndescription: a\n---\n\nbody\n', 'utf8')
  const before = (await buildSnapshot(dir)).revisions.agents
  await fs.writeFile(file, '---\nname: scribe\ndescription: b\n---\n\nbody\n', 'utf8')
  const after = (await buildSnapshot(dir)).revisions.agents
  expect(after).not.toBe(before)
})
```

- [ ] **Step 2: شغّل الاختبارات وتأكّد من فشلها**

Run: `cd engine && npx vitest run tests/web/api.test.ts tests/web/snapshot.test.ts`
Expected: FAIL — المسار 404، و`revisions.agents` غير معرّف

- [ ] **Step 3: التنفيذ**

في `engine/src/web/revision.ts` — أضف إلى `Revisions`:

```ts
  /**
   * `.claude/agents/` — Claude Code's own directory, outside `.mjloop/` and
   * outside `paths` for the same reason `.claude/skills/` is: it is not this
   * engine's tree. Stamped anyway because the Agents tab draws it and writes
   * into it, and a tab that does not refresh when its own write lands is a tab
   * showing yesterday. `stampTree` is enough here — an agent is one file
   * directly inside the directory, not a level deeper the way a `SKILL.md` is.
   */
  agents: string
```

وفي `readRevisions`، أضف `stampTree(path.join(projectDir, '.claude', 'agents'))` إلى `Promise.all` وأعِده تحت المفتاح `agents`.

في `engine/src/web/read.ts` أضف:

```ts
/**
 * The plugin's own `agents/`, resolved the way `web/cli.ts:84` resolves
 * `ENGINE_DIR`: three levels up from this module lands on the plugin root
 * both from `src/web/` under vitest and from `dist/web/` in a build.
 */
export const PLUGIN_AGENTS_DIR = fileURLToPath(new URL('../../../agents/', import.meta.url))

/**
 * The two agent directories, side by side and never merged.
 *
 * A project agent shadows a plugin one of the same name, and folding them into
 * one list would hide exactly that. `path` is dropped on the way out: it is an
 * absolute path, which the page has no use for and must not display.
 */
export async function readAgentsView(projectDir: string): Promise<AgentsView> {
  const [project, plugin] = await Promise.all([
    listAgents(projectAgentsDir(projectDir), 'project'),
    listAgents(PLUGIN_AGENTS_DIR, 'plugin'),
  ])
  const view = ({ path: _path, ...rest }: AgentDoc): AgentView => rest
  return {
    project: project.agents.map(view),
    plugin: plugin.agents.map(view),
    // The plugin's own unreadable files are not this project's problem to
    // report — a broken plugin file is a bug in the plugin, and a project
    // cannot act on it.
    unreadable: project.unreadable.map((entry) => ({ path: path.basename(entry.path) })),
  }
}
```

> `PLUGIN_AGENTS_DIR` مسارٌ محسوب من `import.meta.url`. تحقّق منه فعلياً قبل أن تمضي: من `engine/src/web/read.ts` يجب أن يشير إلى `<repo>/agents/`. إن لم يفعل، صحّح عدد المستويات ولا تخمّنه.

في `engine/src/web/api.ts` — أضف داخل `switch`:

```ts
    case 'agents':
      // No parameter, and none a later story should add: the tab draws every
      // agent at once, and a route that took a name would be the read half of
      // one that opened a file by a string from the wire. Writes go through
      // `web/writes.ts`, where the name is confined by `AgentNameSchema`.
      if (segments.length !== 1) break
      return ok(await readAgentsView(projectDir))
```

في `engine/tests/web/helpers/page.ts` — أضف `agents: '-'` إلى `revisions` في `emptySnapshot`.

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npx vitest run tests/web/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/revision.ts engine/src/web/protocol.ts engine/src/web/read.ts engine/src/web/api.ts engine/tests/
git commit -m "feat(web): serve the two agent directories over /api/agents

Project and plugin side by side, never merged: a project agent shadows a
plugin one of the same name, and one list would hide exactly that. Rides a
revisions.agents key so the tab refreshes when its own write lands.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: أبواب الكتابة الثلاثة للوكلاء

**Files:**
- Modify: `engine/src/web/codes.ts`, `engine/src/web/writes.ts`
- Modify: `engine/src/web/app/locales/en.json`, `engine/src/web/app/locales/ar.json`
- Modify: `engine/tests/web/boundary.test.ts`
- Test: `engine/tests/web/writes.test.ts` (أنشئه إن لم يكن موجوداً؛ وإلا أضف إليه)

**Interfaces:**
- Consumes: `writeAgent`, `deleteAgent`, `AgentWriteError`, `listAgents`, `PLUGIN_AGENTS_DIR`
- Produces: ثلاثة أعضاء جديدة في `WriteSchema`:
  ```ts
  { kind: 'agent.create', name, description, tools, model, body }
  { kind: 'agent.update', name, digest, description, tools, model, body }
  { kind: 'agent.delete', name, digest }
  ```

`agent.create` و`agent.update` لا يحملان `extra`: المتصفّح لا يؤلّف حقولاً لا يعرفها. الحقول غير المعروفة تُقرأ من الملف داخل القفل وتُعاد كما هي.

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
// engine/tests/web/writes.test.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyWrite } from '../../src/web/writes.js'
import { agentDigest, readAgent } from '../../src/store/agent-store.js'
// … أعِد استخدام تهيئة المشروع المؤقّت التي يستعملها tests/web/api.test.ts

const CREATE = {
  kind: 'agent.create' as const,
  name: 'scribe',
  description: 'Writes notes.',
  tools: 'Read, Write',
  model: 'sonnet',
  body: 'You write notes.\n\n```json\n{"status":"pass"}\n```',
}

describe('the agent write doors', () => {
  it('creates an agent', async () => {
    expect(await applyWrite(dir, CREATE)).toEqual({ ok: true })
    expect((await readAgent(dir, 'scribe'))?.description).toBe('Writes notes.')
  })

  it('refuses a name that shadows a plugin agent', async () => {
    const result = await applyWrite(dir, { ...CREATE, name: 'verifier' })
    expect(result).toEqual({ ok: false, code: 'write.refused.agent.shadow' })
  })

  it('refuses an update whose digest has moved', async () => {
    await applyWrite(dir, CREATE)
    const result = await applyWrite(dir, {
      kind: 'agent.update',
      name: 'scribe',
      digest: agentDigest('stale'),
      description: 'Writes notes.',
      tools: null,
      model: null,
      body: 'edited',
    })
    expect(result).toEqual({ ok: false, code: 'write.stale.agent' })
    expect((await readAgent(dir, 'scribe'))?.body).toContain('You write notes.')
  })

  it('preserves a frontmatter field the browser never sends', async () => {
    await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true })
    const file = path.join(dir, '.claude', 'agents', 'scribe.md')
    const raw = '---\nname: scribe\ndescription: a\ncolor: blue\n---\n\nbody\n'
    await fs.writeFile(file, raw, 'utf8')
    await applyWrite(dir, {
      kind: 'agent.update',
      name: 'scribe',
      digest: agentDigest(raw),
      description: 'b',
      tools: null,
      model: null,
      body: 'body',
    })
    expect((await readAgent(dir, 'scribe'))?.extra).toEqual({ color: 'blue' })
  })

  it('refuses to delete an agent a track names', async () => {
    await applyWrite(dir, CREATE)
    const doc = await readAgent(dir, 'scribe')
    await writeConfigWithTrack(dir, { required: ['scribe'] })  // helper in this file
    const result = await applyWrite(dir, { kind: 'agent.delete', name: 'scribe', digest: doc?.digest ?? '' })
    expect(result).toEqual({ ok: false, code: 'write.refused.agent.inUse' })
    expect(await readAgent(dir, 'scribe')).not.toBeNull()
  })

  it('refuses every agent write while a run is open', async () => {
    await setStatusRunning(dir)  // helper in this file
    expect(await applyWrite(dir, CREATE)).toEqual({ ok: false, code: 'write.refused.running' })
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/writes.test.ts`
Expected: FAIL — `agent.create` ليس عضواً في الاتحاد المميَّز

- [ ] **Step 3: التنفيذ**

في `engine/src/web/codes.ts` أضف إلى `WEB_CODES`:

```ts
  /* the agent doors. A refusal names which door closed and nothing else: the
     five below are five different next steps for the person reading the
     screen — reopen the editor, pick another name, edit the track first, wait
     for the run, or fix the field. */
  'write.stale.agent',
  'write.invalid.agent',
  'write.refused.agent.shadow',
  'write.refused.agent.inUse',
  'write.refused.running',
  'write.ok.agent',
```

في `engine/src/web/writes.ts` أضف إلى `WriteSchema`:

```ts
  z.strictObject({
    kind: z.literal('agent.create'),
    name: AgentNameSchema,
    description: z.string().min(1).max(500),
    tools: z.string().max(500).nullable(),
    model: z.string().max(100).nullable(),
    /**
     * The agent's own prompt. Free text, and that is not a violation of the
     * no-prose rule: that rule constrains *server-authored* prose. This is the
     * user's own words travelling into a project file, the same category as
     * `note` and `reason` above.
     */
    body: z.string().max(100000),
  }),
  z.strictObject({
    kind: z.literal('agent.update'),
    name: AgentNameSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().min(1).max(500),
    tools: z.string().max(500).nullable(),
    model: z.string().max(100).nullable(),
    body: z.string().max(100000),
  }),
  z.strictObject({
    kind: z.literal('agent.delete'),
    name: AgentNameSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
```

وأضف الحرّاس قبل الإرسال إلى المخزن، داخل `applyWrite`:

```ts
/** Every agent door, and only those. */
const AGENT_KINDS = ['agent.create', 'agent.update', 'agent.delete']

/**
 * Which tracks name an agent, and in which list.
 *
 * Read from the config rather than remembered: an agent's membership is the
 * track's business, and a cached answer here is one that can be wrong at
 * exactly the moment it matters — when somebody is deleting the agent.
 */
async function agentUsedByTrack(projectDir: string, name: string): Promise<boolean> {
  const config = await loadConfig(projectDir)
  return Object.values(config.tracks).some((track) =>
    [
      ...track.required,
      ...(track.available ?? []),
      ...(track.closing ?? []),
      ...(track.gate?.blocks ?? []),
      track.gate?.proven_by ?? '',
      track.map?.drafted_by ?? '',
    ].includes(name),
  )
}
```

وفي `HANDLERS` أضف الثلاثة، ثم في `applyWrite` — قبل استدعاء المُعالِج:

```ts
  if (AGENT_KINDS.includes(write.kind)) {
    // Refused while a run is open, for a reason the config editor does not
    // have: the roster is pinned and the briefs are already sent, so an agent
    // edited mid-run makes what ran and what is recorded two different things.
    const state = await stateSummary(projectDir)
    if (state.status === 'running') return { ok: false, code: 'write.refused.running' }
  }
```

وحوّل `AgentWriteError` إلى رمز في `catch`:

```ts
    if (error instanceof AgentWriteError) {
      const code = {
        stale: 'write.stale.agent',
        exists: 'write.invalid.agent',
        missing: 'write.stale.agent',
        invalid: 'write.invalid.agent',
        reserved: 'write.refused.agent.shadow',
      } as const satisfies Record<AgentWriteFailure, WebCode>
      return { ok: false, code: code[error.kind] }
    }
```

> `missing` تُترجم إلى `write.stale.agent` عمداً: للمتصفّح هذه حقيقة واحدة — الشاشة التي ضُغط عليها لم تعد صحيحة ولم يتغيّر شيء — وثلاثة رموز لفرقٍ لا يستطيع القارئ التصرّف بناءً عليه هي نثرُ المخزن على السلك.

أضف مفاتيح اللغات الستّة إلى `en.json` و`ar.json` تحت `write.` (وهو فضاء اسمٍ قائم).

في `engine/tests/web/boundary.test.ts` أضف اختباراً:

```ts
  it('reaches the agent store from exactly one file', () => {
    for (const op of ['writeAgent', 'deleteAgent']) {
      const importers = files.filter((file) => imported(read(file)).has(op))
      expect(importers, op).toEqual(['writes.ts'])
    }
  })
```

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS بالكامل — بما فيه `boundary` و`locales`

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/ engine/tests/web/ engine/src/web/app/locales/
git commit -m "feat(web): three guarded doors for agent files

The config.patch class, not the runStart class: an operator's decision
recorded compare-and-swap, never the loop reporting work. Refused outright
while a run is open, and refused for an agent a track still names.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: توسيع أدوار قبول المهارات، وباب `skill.agents`

**Files:**
- Modify: `engine/src/schemas/skill-acceptance.ts`, `engine/src/store/skill-acceptance-store.ts`, `engine/src/ops/run.ts`, `engine/src/web/app/lib/stories.ts`, `engine/src/web/writes.ts`, `engine/src/web/read.ts`
- Test: `engine/tests/store/skill-acceptance-store.test.ts` (يُضاف إليه)، `engine/tests/web/writes.test.ts` (يُضاف إليه)

**Interfaces:**
- Produces:
  ```ts
  // store/skill-acceptance-store.ts
  export function acceptanceDigest(record: ProjectSkillAcceptance): string
  export async function setAcceptanceAgents(projectDir: string, skillId: string, agents: string[], expectDigest: string): Promise<void>
  // web/writes.ts
  { kind: 'skill.agents', skill: string, digest: string, agents: string[] }
  ```
- `/api/skills` يكتسب `recordDigest` على كل قبول. **ليس `digest`**: `ProjectSkillAcceptanceSchema` يحمل حقلاً بهذا الاسم أصلاً (`schemas/skill-acceptance.ts:39`) وهو بصمة *محتوى الحزمة* التي يتمّ عليها الوصل في `lib/skills.ts`. اسمٌ ثانٍ بنفس الكلمة يدهسه في `{ ...record, digest }` دون خطأ ترجمة، لأن كليهما `string`.

**القاعدة الجديدة:** الأدوار المقبولة = أسماء الوكلاء التي يذكرها أي مسار في `config.yaml`، بدل القائمة الرباعية الثابتة. اتّجاه الطبقات يمنع `schemas/` من الاستيراد من `ops/`، فالمجموعة تُمرَّر **إلى** موضع التحقّق.

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
// engine/tests/store/skill-acceptance-store.test.ts — يُضاف
it('accepts an agent any track names, not only the four fixed roles', async () => {
  await writeConfigWithTrack(dir, { required: ['scribe', 'verifier'] })
  await acceptSkill(dir, { ...INPUT, agents: ['scribe'] })
  expect((await readAcceptance(dir, INPUT.skillId))?.agents).toEqual(['scribe'])
})

it('still refuses an agent no track names', async () => {
  await writeConfigWithTrack(dir, { required: ['scribe'] })
  await expect(acceptSkill(dir, { ...INPUT, agents: ['ghost'] })).rejects.toThrow(UnknownAcceptanceAgentError)
})

it('sets the agents of an existing acceptance and leaves every other field alone', async () => {
  await writeConfigWithTrack(dir, { required: ['scribe', 'critic'] })
  await acceptSkill(dir, { ...INPUT, agents: ['scribe'] })
  const before = await readAcceptance(dir, INPUT.skillId)
  await setAcceptanceAgents(dir, INPUT.skillId, ['critic'], acceptanceDigest(before!))
  const after = await readAcceptance(dir, INPUT.skillId)
  expect(after?.agents).toEqual(['critic'])
  expect({ ...after, agents: [] }).toEqual({ ...before, agents: [] })
})

it('refuses a digest that has moved', async () => {
  await writeConfigWithTrack(dir, { required: ['scribe'] })
  await acceptSkill(dir, { ...INPUT, agents: ['scribe'] })
  await expect(setAcceptanceAgents(dir, INPUT.skillId, ['scribe'], 'x'.repeat(64))).rejects.toThrow()
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/store/skill-acceptance-store.test.ts`
Expected: FAIL — `setAcceptanceAgents is not a function`، ورفض `scribe` كدور غير معروف

- [ ] **Step 3: التنفيذ**

1. في `engine/src/schemas/skill-acceptance.ts`: استبدل التعليق على `SKILL_ACCEPTANCE_AGENTS` بشرحٍ للقاعدة الجديدة، واحتفظ بالثابت كـ**احتياطي** لمشروعٍ بلا مسارات:

```ts
/**
 * The roles skill selection routes to when a project declares no tracks at all.
 *
 * It used to be the whole answer, and a fixed four. The set is now whichever
 * agents a track in `config.yaml` names, because a project that adds an agent
 * to a track has already said that agent is one this loop runs — and a skill it
 * cannot be offered to is a skill that silently does nothing. This constant
 * remains as the floor: a config with no tracks routes to these four rather
 * than to nothing.
 */
export const SKILL_ACCEPTANCE_AGENTS = ['planner', 'builder', 'critic', 'verifier'] as const
```

2. في `engine/src/store/skill-acceptance-store.ts`: غيّر `acceptSkill` ليحسب المجموعة المقبولة من الإعداد:

```ts
/**
 * The agent names this project's own tracks name, or the fixed floor when it
 * declares none.
 *
 * Read from the config on every call rather than cached: an acceptance is
 * checked against the tracks that exist *now*, and a cached set is one that is
 * wrong exactly when a track has just gained the agent somebody is accepting a
 * skill for.
 */
async function routableAgents(projectDir: string): Promise<Set<string>> {
  const config = await loadConfig(projectDir)
  const names = Object.values(config.tracks).flatMap((track) => [
    ...track.required,
    ...(track.available ?? []),
    ...(track.closing ?? []),
  ])
  return names.length === 0 ? new Set(SKILL_ACCEPTANCE_AGENTS) : new Set(names)
}
```

واستخدمها بدل `SKILL_ACCEPTANCE_AGENTS` في `unknownAgents`، وبدلها في `input.agents ?? [...]` الافتراضي.

3. أضف البصمة والمُعدِّل:

```ts
/**
 * sha256 over the serialised record.
 *
 * A counter revision was the alternative and was rejected: it would oblige
 * every acceptance already on disk to grow a field, and it answers no question
 * this one does not. Same shape and same job as `configRevision`.
 */
export function acceptanceDigest(record: ProjectSkillAcceptance): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

/**
 * The one field of an acceptance the dashboard may set.
 *
 * Not the status, not the components, not the update policy: those change what
 * a skill *is* to this project, and `mjloop-cli skills accept|disable` is where
 * that is decided. Which agents a skill is offered to is the routing question
 * the Agents tab exists to answer.
 */
export async function setAcceptanceAgents(
  projectDir: string,
  skillId: string,
  agents: string[],
  expectDigest: string,
): Promise<void> {
  const routable = await routableAgents(projectDir)
  const unknown = agents.filter((agent) => !routable.has(agent))
  if (unknown.length > 0) throw new UnknownAcceptanceAgentError(unknown)
  await withLock(resolveLoopPaths(projectDir).lock, async () => {
    const current = await readAcceptance(projectDir, skillId)
    if (current === null) throw new SkillAcceptanceNotFoundError(skillId)
    if (acceptanceDigest(current) !== expectDigest) {
      throw new StalePreconditionError('skill', 'the acceptance moved underneath the editor')
    }
    await writeAcceptance(projectDir, { ...current, agents })
  })
}
```

> `writeAcceptance` هو الكاتب الداخلي القائم في هذا الملف. إن لم يكن مُصدَّراً بهذا الاسم، استعمل ما يستعمله `setAcceptanceStatus` بالضبط ولا تضف كاتباً ثانياً. و`StalePreconditionError` يأخذ `PreconditionSubject`؛ إن لم يكن `'skill'` عضواً فيه، وسّعه وأضف رمزاً مطابقاً إلى خريطة `STALE` في `web/writes.ts` — وهذه الخريطة اليوم لها ثلاثة مفاتيح فقط، فأي توسعة تُلزمك بالرمز.

4. في `engine/src/ops/run.ts`: `SKILL_SELECTION_AGENTS` تُشتقّ من نفس القاعدة. اقرأ الموضع أولاً واتّبع ما يفعله بالضبط.

5. في `engine/src/web/app/lib/stories.ts:264`: حدّث التعليق والثابت ليقولا إن المصدر صار الإعداد، ومرّر أسماء المسارات من مستند الإعداد الذي تحمله الصفحة.

6. في `engine/src/web/read.ts`: أضف `digest: acceptanceDigest(record)` إلى كل قبول في `readSkillsView`.

7. في `engine/src/web/writes.ts`: الباب الرابع.

```ts
  z.strictObject({
    kind: z.literal('skill.agents'),
    skill: IdSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    agents: z.array(AgentNameSchema).max(50),
  }),
```

ومُعالِجه يستدعي `setAcceptanceAgents`، وهو أيضاً مرفوض أثناء تشغيلة نشطة (أضِف `'skill.agents'` إلى `AGENT_KINDS`، وأعِد تسميته `GUARDED_WHILE_RUNNING`).

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/ engine/tests/
git commit -m "feat: route a skill to any agent a track names

The fixed four roles become whichever agents this project's own tracks
declare, with the four kept as the floor for a config with no tracks. Adds
setAcceptanceAgents — the one field of an acceptance the dashboard may set
— behind a digest, and the skill.agents door in front of it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: منطق المتصفّح للوكلاء

**Files:**
- Create: `engine/src/web/app/lib/agents.ts`
- Test: `engine/tests/web/lib-agents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AgentUsage { track: string; list: 'required' | 'available' | 'closing' | 'blocks' | 'gate' | 'map' }
  export function usage(config: Config | null, name: string): AgentUsage[]
  export function hasContract(body: string): boolean
  export function copyName(taken: readonly string[], source: string): string
  ```

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
// engine/tests/web/lib-agents.test.ts
import { describe, expect, it } from 'vitest'
import { copyName, hasContract, usage } from '../../src/web/app/lib/agents.js'

const CONFIG = {
  tracks: {
    build: { required: ['builder', 'verifier'], available: ['critic'], closing: ['docs'], max_cycles: 5 },
    fix: {
      required: ['reproducer', 'fixer'],
      available: [],
      closing: [],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
      map: { drafted_by: 'fixer' },
    },
  },
} as unknown as Config

describe('where an agent is used', () => {
  it('finds every list that names it', () => {
    expect(usage(CONFIG, 'fixer')).toEqual([
      { track: 'fix', list: 'required' },
      { track: 'fix', list: 'blocks' },
      { track: 'fix', list: 'map' },
    ])
  })

  it('finds a gate prover', () => {
    expect(usage(CONFIG, 'reproducer')).toEqual([
      { track: 'fix', list: 'required' },
      { track: 'fix', list: 'gate' },
    ])
  })

  it('is empty for an agent no track names', () => {
    expect(usage(CONFIG, 'scribe')).toEqual([])
  })

  it('is empty when there is no config to read', () => {
    expect(usage(null, 'builder')).toEqual([])
  })
})

describe('the output contract', () => {
  it('finds a fenced json block carrying the status field', () => {
    expect(hasContract('text\n\n```json\n{\n  "status": "pass",\n  "summary": "x"\n}\n```\n')).toBe(true)
  })

  it('does not accept a fenced block that is not the contract', () => {
    expect(hasContract('```json\n{ "foo": 1 }\n```')).toBe(false)
  })

  it('does not accept prose about the contract', () => {
    expect(hasContract('Return the standard contract with a status field.')).toBe(false)
  })
})

describe('naming a derived copy', () => {
  it('appends -copy, then a counter', () => {
    expect(copyName([], 'builder')).toBe('builder-copy')
    expect(copyName(['builder-copy'], 'builder')).toBe('builder-copy-2')
    expect(copyName(['builder-copy', 'builder-copy-2'], 'builder')).toBe('builder-copy-3')
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/lib-agents.test.ts`
Expected: FAIL — الوحدة غير موجودة

- [ ] **Step 3: التنفيذ**

`engine/src/web/app/lib/agents.ts`:

```ts
/**
 * The Agents tab's pure half — DOM-free, so it is testable without mounting a
 * component, the same split `lib/config.ts` already makes for the Config tab.
 */
import type { Config } from '../types/protocol.js'

export interface AgentUsage {
  track: string
  list: 'required' | 'available' | 'closing' | 'blocks' | 'gate' | 'map'
}

/**
 * Every place a track names this agent.
 *
 * This is what makes deleting an agent a decision rather than a gamble: the
 * server refuses the delete for exactly this reason, and showing the reason
 * before the button is pressed is the difference between a guard and a wall.
 * Track order is `Object.keys`'s, sorted, so the list does not reshuffle
 * between renders.
 */
export function usage(config: Config | null, name: string): AgentUsage[] {
  if (config === null) return []
  const out: AgentUsage[] = []
  for (const track of Object.keys(config.tracks).sort()) {
    const entry = config.tracks[track]
    if (entry === undefined) continue
    if (entry.required.includes(name)) out.push({ track, list: 'required' })
    if ((entry.available ?? []).includes(name)) out.push({ track, list: 'available' })
    if ((entry.closing ?? []).includes(name)) out.push({ track, list: 'closing' })
    if ((entry.gate?.blocks ?? []).includes(name)) out.push({ track, list: 'blocks' })
    if (entry.gate?.proven_by === name) out.push({ track, list: 'gate' })
    if (entry.map?.drafted_by === name) out.push({ track, list: 'map' })
  }
  return out
}

/**
 * Whether the body carries the output contract rather than a promise of one.
 *
 * The `mjloop-extend` skill records the measurement this exists to act on:
 * agents *pointing at* the contract violated it on their first attempt and
 * each cost a corrective retry, while agents carrying it inline complied first
 * time. So this looks for a fenced json block with the contract's own required
 * field in it, and deliberately does not accept a sentence about the contract.
 */
export function hasContract(body: string): boolean {
  for (const match of body.matchAll(/```json\s*([\s\S]*?)```/g)) {
    if (/"status"\s*:/.test(match[1] ?? '')) return true
  }
  return false
}

/** `<source>-copy`, then `-2`, `-3` — the same shape `TrackEditor.vue`'s own duplicate uses. */
export function copyName(taken: readonly string[], source: string): string {
  let candidate = `${source}-copy`
  let n = 2
  while (taken.includes(candidate)) candidate = `${source}-copy-${n++}`
  return candidate
}
```

- [ ] **Step 4: شغّل الاختبار**

Run: `cd engine && npx vitest run tests/web/lib-agents.test.ts && npm run typecheck`
Expected: PASS — أحد عشر اختباراً

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/lib/agents.ts engine/tests/web/lib-agents.test.ts
git commit -m "feat(web): the Agents tab's pure half

Where a track names an agent, whether a body carries the output contract
rather than a promise of one, and what to call a derived copy.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: تبويب الوكلاء — القائمة والاستخدام

**Files:**
- Create: `engine/src/web/app/panels/Agents.vue`, `engine/src/web/app/components/AgentCard.vue`
- Modify: `engine/src/web/app/composables/useTabs.ts`, `engine/src/web/app/App.vue`, `engine/src/web/app/locales/en.json`, `engine/src/web/app/locales/ar.json`, `engine/tests/web/locales.test.ts` (فضاء الاسم `agents`)
- Test: `engine/tests/web/panel-agents.test.ts`

**Interfaces:**
- Consumes: `useFeed`، `usage` من المهمّة 6، `AgentsView` من المهمّة 3
- Produces: تبويب `'agents'` في `TabId` و`TABS`

- [ ] **Step 1: اكتب الاختبار الفاشل**

`engine/tests/web/panel-agents.test.ts` — على منوال `tests/web/panel-skills.test.ts` تماماً (`serve`, `boot`, `readLocale`):

```ts
it('draws the project agents and the plugin agents apart', async () => {
  serve({
    '/api/agents': {
      project: [{ name: 'scribe', source: 'project', description: 'Writes notes.', tools: null, model: null, extra: {}, body: 'x', digest: 'a'.repeat(64) }],
      plugin: [{ name: 'verifier', source: 'plugin', description: 'Judges.', tools: null, model: null, extra: {}, body: 'y', digest: 'b'.repeat(64) }],
      unreadable: [],
    },
  })
  const page = await boot(emptySnapshot({ revisions: { ...emptySnapshot().revisions, agents: 'r1' } }))
  await flushPromises()
  expect(page.find('#agents-project').text()).toContain('scribe')
  expect(page.find('#agents-plugin').text()).toContain('verifier')
})

it('says which tracks name an agent', async () => {
  // config feed carries a build track whose required list has scribe in it
  serve({ '/api/agents': AGENTS, '/api/config': CONFIG_VIEW })
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('[data-agent="scribe"] .agent-usage').text()).toContain('build')
})

it('offers no delete for a plugin agent', async () => {
  serve({ '/api/agents': AGENTS })
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('[data-agent="verifier"] .danger').exists()).toBe(false)
})

it('reports an unreadable agent file rather than hiding it', async () => {
  serve({ '/api/agents': { project: [], plugin: [], unreadable: [{ path: 'broken.md' }] } })
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('#agents-unreadable').text()).toContain('broken.md')
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/panel-agents.test.ts`
Expected: FAIL — `Agents.vue` غير موجود

- [ ] **Step 3: التنفيذ**

- `useTabs.ts`: أضف `'agents'` و`'tracks'` إلى `TabId` وإلى `TABS`، بعد `'skills'`.
- `App.vue`: `<Agents v-else-if="active === 'agents'" />` داخل `<KeepAlive>`، مع الاستيراد.
- `Agents.vue`: تغذية `/api/agents` عبر `useFeed({ dep: (state) => state.revisions.agents, path: () => '/api/agents' })`، وتغذية `/api/config` على `revisions.config`، ثم قسمان — `#agents-project` و`#agents-plugin` — يرسمان `AgentCard.vue`، وقسم `#agents-unreadable`.
- `AgentCard.vue`: يأخذ `:agent` و`:config`، يرسم الرأس والوصف والأدوات والنموذج، وقائمة `usage(config, agent.name)`، وأزرار «تعديل» و«حذف» لوكيل المشروع فقط، و«اشتقّ نسخة» لوكيل البِلَغن. الجذر يحمل `:data-agent="agent.name"`.
- مفاتيح اللغة تحت `agents.` و`panel.agents.`، وأضف `'agents'` و`'tracks'` إلى `NAMESPACES` في `tests/web/locales.test.ts`.

> `tests/web/discipline.test.ts` يفرض قواعد وصولية على كل `.vue`. اقرأه قبل كتابة القوالب واتّبع ما يفرضه — لا تكتشفه من فشلٍ لاحق.

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/ engine/tests/web/
git commit -m "feat(web): the Agents tab — the list and where each agent is used

Project and plugin agents apart, and for each one the tracks that name it.
That last list is why deleting is a decision rather than a gamble: the
server refuses the delete for exactly that reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: محرّر الوكيل

**Files:**
- Create: `engine/src/web/app/components/AgentEditor.vue`
- Modify: `engine/src/web/app/components/AgentCard.vue`, اللغات
- Test: `engine/tests/web/panel-agents.test.ts` (يُضاف إليه)

**Interfaces:**
- Consumes: `submit` من `stores/session.js`، `hasContract` و`copyName` من `lib/agents.js`، أبواب المهمّة 4

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
it('sends the digest it was shown, and nothing else', async () => {
  const sent: unknown[] = []
  // stub the socket the way tests/web/store.test.ts does, capturing frames
  const page = await bootWithSocket(sent)
  await page.find('[data-agent="scribe"] .agent-edit').trigger('click')
  await page.find('#agent-description').setValue('Writes better notes.')
  await page.find('#agent-form').trigger('submit')
  expect(sent).toContainEqual(
    expect.objectContaining({
      write: expect.objectContaining({ kind: 'agent.update', name: 'scribe', digest: 'a'.repeat(64) }),
    }),
  )
})

it('warns when the body carries no output contract', async () => {
  const page = await boot(/* agent whose body is prose only */)
  await page.find('[data-agent="scribe"] .agent-edit').trigger('click')
  expect(page.find('#agent-contract-warning').exists()).toBe(true)
})

it('does not warn when it does', async () => {
  const page = await boot(/* agent whose body has a ```json block with "status" */)
  await page.find('[data-agent="scribe"] .agent-edit').trigger('click')
  expect(page.find('#agent-contract-warning').exists()).toBe(false)
})

it('derives a copy of a plugin agent under a free name', async () => {
  const sent: unknown[] = []
  const page = await bootWithSocket(sent)
  await page.find('[data-agent="verifier"] .agent-derive').trigger('click')
  await page.find('#agent-form').trigger('submit')
  expect(sent).toContainEqual(
    expect.objectContaining({ write: expect.objectContaining({ kind: 'agent.create', name: 'verifier-copy' }) }),
  )
})

it('refuses to submit an empty description', async () => {
  const sent: unknown[] = []
  const page = await bootWithSocket(sent)
  await page.find('[data-agent="scribe"] .agent-edit').trigger('click')
  await page.find('#agent-description').setValue('   ')
  await page.find('#agent-form').trigger('submit')
  expect(sent).toEqual([])
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/panel-agents.test.ts`
Expected: FAIL — لا يوجد `.agent-edit`

- [ ] **Step 3: التنفيذ**

`AgentEditor.vue` — نموذج بحقول `name` (للقراءة عند التعديل)، `description`، `tools`، `model`، و`<textarea>` للجسم بـ `dir="ltr"`. يحمل `digest` المعروض في متغيّرٍ محلّي، ويرسله كما هو. `submit()` يبني `agent.update` عند التعديل و`agent.create` عند الاشتقاق أو الإنشاء. تحذير العقد `v-if="!hasContract(body)"` على `#agent-contract-warning`.

> كل زرّ في هذا المكوّن يستدعي `submit()` من `stores/session.js` مباشرةً — لا مسودّة مشتركة هنا، بخلاف تبويب الإعداد: ملفّ الوكيل مستندٌ واحد، وليس وثيقةً تجمع تغييرات عدّة أقسام قبل حفظةٍ واحدة.

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/ engine/tests/web/
git commit -m "feat(web): the agent editor

Frontmatter fields, the prompt body, and a warning when the body carries no
output contract — the mjloop-extend skill measured that agents pointing at
the contract violate it on their first attempt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: المهارات على بطاقة الوكيل

**Files:**
- Create: `engine/src/web/app/components/AgentSkillRow.vue`
- Modify: `engine/src/web/app/components/AgentCard.vue`, اللغات
- Test: `engine/tests/web/panel-agents.test.ts` (يُضاف إليه)

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
it('lists the accepted skills routed to this agent', async () => {
  serve({ '/api/agents': AGENTS, '/api/skills': SKILLS_WITH_ACCEPTANCE_FOR_SCRIBE })
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('[data-agent="scribe"] .agent-skills').text()).toContain('create-readme')
})

it('sends skill.agents with the acceptance digest when a skill is attached', async () => {
  const sent: unknown[] = []
  const page = await bootWithSocket(sent)
  await flushPromises()
  await page.find('[data-agent="scribe"] [data-skill="create-readme"] input').setValue(true)
  expect(sent).toContainEqual(
    expect.objectContaining({
      write: expect.objectContaining({ kind: 'skill.agents', skill: 'create-readme', digest: 'c'.repeat(64), agents: ['scribe'] }),
    }),
  )
})

it('offers no skill checkbox for a plugin agent', async () => {
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('[data-agent="verifier"] .agent-skills input').exists()).toBe(false)
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/panel-agents.test.ts`
Expected: FAIL — لا يوجد `.agent-skills`

- [ ] **Step 3: التنفيذ**

`AgentCard.vue` يكتسب تغذية `/api/skills` (على `revisions.skills`)، ويرسم صفّاً لكل قبولٍ نشط. المربّع يرسل `skill.agents` بمجموعة `agents` الجديدة كاملةً — لا فرقاً — و`digest` القبول كما ورد من التغذية.

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/ engine/tests/web/
git commit -m "feat(web): attach an accepted skill to an agent from its card

The one field of an acceptance the dashboard may set, behind the digest the
feed handed it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: فصل تغييرات الإعداد ونقل محرّر المسارات

**Files:**
- Modify: `engine/src/web/app/lib/config.ts`, `engine/src/web/app/panels/Config.vue`
- Create: `engine/src/web/app/panels/Tracks.vue`
- Modify: `engine/src/web/app/App.vue`، اللغات
- Test: `engine/tests/web/lib.test.ts` (يُضاف إليه)، `engine/tests/web/panel-config.test.ts` (يُعدَّل)، `engine/tests/web/panel-tracks.test.ts` (يُنشأ)

**Interfaces:**
- Produces:
  ```ts
  export function collectSettingsChanges(form: ConfigFormValues, baseline: Config): ConfigChange[]
  export function collectTrackChanges(draft: Draft, baseline: Config): ConfigChange[]
  ```
  `collectConfigChanges` تُحذف؛ من كان يستدعيها يستدعي الاثنتين.

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
// engine/tests/web/lib.test.ts — يُضاف
it('splits the change list at the tracks boundary', () => {
  const baseline = CONFIG
  const form = { ...seedFormValues(baseline), autonomous: !baseline.autonomous }
  const draft = seedDraft(baseline)
  draft.tracks['build']!.max_cycles = 9

  const settings = collectSettingsChanges(form, baseline)
  const tracks = collectTrackChanges(draft, baseline)

  // Neither half reaches into the other's keys.
  expect(settings.every((change) => change.kind !== 'track')).toBe(true)
  expect(tracks.every((change) => change.kind === 'track')).toBe(true)
  // And together they are still the whole change set.
  expect(settings.length + tracks.length).toBe(2)
})
```

وفي `panel-config.test.ts`: اختبار يؤكّد أن التبويب لم يعد يرسم محرّر المسارات:

```ts
it('no longer carries the track editors', async () => {
  const page = await boot(/* … */)
  await flushPromises()
  expect(page.find('#config-track-editors').exists()).toBe(false)
})
```

وفي `panel-tracks.test.ts`: اختبار يؤكّد أن التبويب الجديد يرسمها ويحفظ.

- [ ] **Step 2: شغّل الاختبارات وتأكّد من فشلها**

Run: `cd engine && npx vitest run tests/web/lib.test.ts tests/web/panel-config.test.ts tests/web/panel-tracks.test.ts`
Expected: FAIL

- [ ] **Step 3: التنفيذ**

- في `lib/config.ts`: قسّم الدالة. المنطق نفسه، مقسوماً عند حدود `kind: 'track'`؛ لا تعيد كتابة أيٍّ من قواعد الرفض.
- `Tracks.vue`: نسخة من هيكل `Config.vue` — نفس `baseline`/`draft`/`mutate`/حارس إعادة البذر/`conflict` — لكنها تستدعي `collectTrackChanges` وترسم `TrackEditors`. `Config.vue` يفقد `TrackEditors` و`agentNames` والـ`datalist` إن لم يعد يستعملها، ويستدعي `collectSettingsChanges`.
- `App.vue`: `<Tracks v-else-if="active === 'tracks'" />`.

> تنبيه: مسودّتان تكتبان إلى `config.yaml` بنفس آلية المراجعة. اختبر صراحةً أن حفظاً من تبويب المسارات بينما تبويب الإعداد متّسخ **يرفض** الثاني برمز `write.stale.config` بدل أن يدهسه — هذا هو ما تحميه المراجعة أصلاً، وهو الاختبار الذي يثبت أن الفصل لم يفتح ثغرة.

- [ ] **Step 4: شغّل الاختبارات**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/ engine/tests/web/
git commit -m "refactor(web): move the track editors to their own tab

One editor per document half, and one collect function each. Two drafts
racing on one revision was the alternative, and the revision refuses the
loser — which is now a test rather than a hope.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: طبقات المخطّط

**Files:**
- Create: `engine/src/web/app/lib/trackgraph.ts`
- Test: `engine/tests/web/lib-trackgraph.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GraphNode { id: string; agent: string; list: 'required' | 'available' | 'closing'; layer: number; index: number }
  export interface GraphEdge { id: string; source: string; target: string; kind: 'order' | 'gate' }
  export function layout(track: Track): { nodes: GraphNode[]; edges: GraphEdge[] }
  export function wouldCycle(track: Track, from: string, to: string): boolean
  ```

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
// engine/tests/web/lib-trackgraph.test.ts
import { describe, expect, it } from 'vitest'
import { layout, wouldCycle } from '../../src/web/app/lib/trackgraph.js'

const PLAIN = { required: ['a', 'b'], available: ['c'], closing: ['d'], order: [], max_cycles: 5 }
const ORDERED = { ...PLAIN, order: [{ agent: 'b', after: ['a'] }, { agent: 'c', after: ['b'] }] }

describe('laying a track out', () => {
  it('puts every unconstrained agent on the first layer', () => {
    expect(layout(PLAIN).nodes.filter((node) => node.list !== 'closing').every((node) => node.layer === 0)).toBe(true)
  })

  it('puts an agent one layer past its latest predecessor', () => {
    const byAgent = Object.fromEntries(layout(ORDERED).nodes.map((node) => [node.agent, node.layer]))
    expect(byAgent['a']).toBe(0)
    expect(byAgent['b']).toBe(1)
    expect(byAgent['c']).toBe(2)
  })

  it('puts closing agents on a layer of their own, past everything else', () => {
    const nodes = layout(ORDERED).nodes
    const closing = nodes.find((node) => node.agent === 'd')
    expect(closing?.layer).toBeGreaterThan(Math.max(...nodes.filter((n) => n.agent !== 'd').map((n) => n.layer)))
  })

  it('draws a gate as its own kind of edge', () => {
    const track = { ...PLAIN, gate: { proven_by: 'a', blocks: ['b'] } }
    expect(layout(track).edges).toContainEqual({ id: 'gate:a->b', source: 'a', target: 'b', kind: 'gate' })
  })

  it('emits one edge per predecessor', () => {
    expect(layout(ORDERED).edges.filter((edge) => edge.kind === 'order')).toEqual([
      { id: 'order:a->b', source: 'a', target: 'b', kind: 'order' },
      { id: 'order:b->c', source: 'b', target: 'c', kind: 'order' },
    ])
  })
})

describe('refusing a connection at the moment it is drawn', () => {
  it('refuses an edge that closes a cycle', () => {
    expect(wouldCycle(ORDERED, 'c', 'a')).toBe(true)
  })

  it('refuses an agent naming itself', () => {
    expect(wouldCycle(ORDERED, 'a', 'a')).toBe(true)
  })

  it('allows an edge that does not', () => {
    expect(wouldCycle(ORDERED, 'a', 'd')).toBe(false)
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/lib-trackgraph.test.ts`
Expected: FAIL — الوحدة غير موجودة

- [ ] **Step 3: التنفيذ**

`engine/src/web/app/lib/trackgraph.ts` — ترتيب طوبولوجي بسيط: طبقة الوكيل = أطول مسار من عقدةٍ بلا أسلاف. `closing` على طبقةٍ بعد الجميع، لأن الوكيل الخاتم يغلق التشغيلة لا الدورة. `wouldCycle` بحث عمقٍ من `to` بحثاً عن `from` عبر حواف `order` **وحافة البوابة معاً**: البوابة هي حافة ترتيبٍ مضمرة (`blocks` بعد `proven_by`)، و`TrackSchema.superRefine` و`dispatchWaves` كلاهما يطويها لهذا السبب بالذات. فحصٌ يتجاهلها يسمح بربطٍ يُنتج دورةً يرفضها المحرّك.

> **المواضع لا تُحفظ.** `layout()` تُنتج `layer` و`index`، والمكوّن يحوّلهما إلى إحداثيات. `config.yaml` لا يكتسب حقل إحداثيات، لأنه مستندٌ يقرأه إنسان ويراجعه في git.

- [ ] **Step 4: شغّل الاختبار**

Run: `cd engine && npx vitest run tests/web/lib-trackgraph.test.ts && npm run typecheck`
Expected: PASS — ثمانية اختبارات

- [ ] **Step 5: الالتزام**

```bash
git add engine/src/web/app/lib/trackgraph.ts engine/tests/web/lib-trackgraph.test.ts
git commit -m "feat(web): topological layers and cycle detection for a track

Positions are derived, never stored: config.yaml is a document a person
reads and reviews in git, and a coordinates field would be litter in it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: مخطّط Vue Flow

**Files:**
- Modify: `engine/package.json` (`@vue-flow/core`)
- Create: `engine/src/web/app/components/TrackGraph.vue`, `engine/src/web/app/styles/70-graph.css`
- Modify: `engine/src/web/app/panels/Tracks.vue`, `engine/src/web/app/styles/index.css`، اللغات
- Test: `engine/tests/web/panel-tracks.test.ts` (يُضاف إليه)

- [ ] **Step 1: ثبّت الاعتماد وتحقّق من أنه يُحزَم**

```bash
cd engine && npm add @vue-flow/core
```

ثم تحقّق أن `npm run build` ينجح وأن `dist/web/public/` يكبر — لا تمضِ قبل ذلك.

- [ ] **Step 2: اكتب الاختبار الفاشل**

```ts
it('draws one node per agent in the track', async () => {
  const page = await boot(/* config feed with the build track */)
  await flushPromises()
  await page.find('#tracks-view-graph').trigger('click')
  expect(page.findAll('[data-graph-node]').map((node) => node.attributes('data-graph-node'))).toEqual([
    'builder', 'critic', 'docs', 'verifier',
  ])
})

it('adds an order edge when two nodes are connected', async () => {
  const page = await boot(/* … */)
  await page.find('#tracks-view-graph').trigger('click')
  await page.findComponent(TrackGraph).vm.$emit('connect', { source: 'builder', target: 'verifier' })
  await nextTick()
  // The draft moved, so Save is now live.
  expect(page.find('#tracks-save').attributes('disabled')).toBeUndefined()
})

it('refuses a connection that would close a cycle, and says so', async () => {
  const page = await boot(/* a track whose order already runs a -> b */)
  await page.find('#tracks-view-graph').trigger('click')
  await page.findComponent(TrackGraph).vm.$emit('connect', { source: 'b', target: 'a' })
  await nextTick()
  expect(page.find('#tracks-graph-refusal').exists()).toBe(true)
})

it('keeps the list view reachable, because the graph is not keyboard-drivable', async () => {
  const page = await boot(/* … */)
  await page.find('#tracks-view-graph').trigger('click')
  await page.find('#tracks-view-list').trigger('click')
  expect(page.find('#config-track-editors').exists()).toBe(true)
})
```

- [ ] **Step 3: شغّل الاختبار وتأكّد من فشله**

Run: `cd engine && npx vitest run tests/web/panel-tracks.test.ts`
Expected: FAIL — لا يوجد `#tracks-view-graph`

- [ ] **Step 4: التنفيذ**

`TrackGraph.vue` يستورد `VueFlow` من `@vue-flow/core` ويأخذ `:track` و`:name`، ويحوّل `layout(track)` إلى `nodes`/`edges` بإحداثيات `{ x: layer * 220, y: index * 90 }`. يبعث `connect` و`disconnect` و`remove`، ولا يحمل مسودّةً بنفسه — `Tracks.vue` يبقى المالك الوحيد لـ`mutate`، تماماً كما تفعل بطاقات الإعداد.

حواف البوابة تُمرَّر بـ`animated: false` و`class: 'edge-gate'` و`selectable: false`: بوابةٌ تُسحب هي خلطٌ بين مفهومين يرفضهما المخطّط بشروط مختلفة.

`70-graph.css` يستورد أنماط Vue Flow ويضيف ألوان المجموعات. أضفه إلى `styles/index.css` بترتيبه الرقمي.

> `assetsInlineLimit: Infinity` في `vite.config.ts` يعني أن أي أصلٍ غير نصّي يصير data URI. تحقّق أن حزمة Vue Flow لا تجلب خطّاً أو صورة — إن فعلت، فالبناء ينجح لكن `server.ts` لن يعرف نوعها. اقرأ `tests/web/assets.test.ts` قبل أن تعلن النجاح.

- [ ] **Step 5: شغّل كل شيء**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS، والبناء ينتج `dist/web/public/`

- [ ] **Step 6: الالتزام**

```bash
git add engine/package.json engine/package-lock.json engine/src/web/app/ engine/tests/web/ engine/dist/
git commit -m "feat(web): the track graph

Nodes are the track's agents, edges are its order constraints, and a gate is
drawn but never dragged — it is not an ordering. The list view stays because
a drag canvas has no keyboard path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: الأمر العام وتحديث الوكيل الرئيسي

**Files:**
- Create: `commands/run.md`
- Create: `engine/src/web/app/components/TrackRunForm.vue`
- Modify: `skills/mjloop-leader/SKILL.md`, `engine/src/web/app/panels/Tracks.vue`, `CLAUDE.md`, `README.md`, `docs/usage.md`, `docs/usage.ar.md`، اللغات
- Test: `engine/tests/web/panel-tracks.test.ts` (يُضاف إليه)، `engine/tests/plugin/` (اتّبع ما يفحص ملفّات الأوامر فيه)

- [ ] **Step 1: اكتب الاختبار الفاشل**

```ts
it('enqueues /mjloop:run with the track and the goal', async () => {
  const sent: unknown[] = []
  const page = await bootWithSocket(sent)
  await flushPromises()
  await page.find('[data-track="build"] .track-run-goal').setValue('ship the thing')
  await page.find('[data-track="build"] .track-run').trigger('submit')
  expect(sent).toContainEqual({ type: 'enqueue', command: '/mjloop:run build ship the thing', story: null })
})

it('enqueues nothing for an empty goal', async () => {
  const sent: unknown[] = []
  const page = await bootWithSocket(sent)
  await page.find('[data-track="build"] .track-run').trigger('submit')
  expect(sent).toEqual([])
})
```

وفي `tests/plugin/`: اختبار يؤكّد أن `commands/run.md` له فرونتماتر بـ`description` و`argument-hint`، على منوال ما يفحصه الملف للأوامر القائمة.

- [ ] **Step 2: شغّل الاختبارات وتأكّد من فشلها**

Run: `cd engine && npx vitest run tests/web/panel-tracks.test.ts tests/plugin/`
Expected: FAIL

- [ ] **Step 3: التنفيذ**

`commands/run.md`:

```markdown
---
description: Run any track in this project by name
argument-hint: <track> <goal>
---

Run the track named in the first word of $ARGUMENTS, for the rest of it: $ARGUMENTS

## 1. Check the track exists

Call `mjloop_state_get` and read the config it reports. If the first word is not a key
under `tracks:`, **stop and say so**, listing the tracks that do exist. Do not guess at
the nearest name: running the wrong track spends a whole run producing the wrong kind of
work.

If the first word names one of `edit`, `build`, `fix` or `plan`, say that
`/mjloop:<name>` is the command for it and carries guidance this one does not — then run
it here anyway rather than refusing, because the user asked for this track by name.

## 2. Run it

Follow the **mjloop-leader** skill. Everything it says about composing a roster applies
without change: the roster comes from the track's own `required`, `available` and
`closing` sets, and the gate and the order graph are the track's, not this command's.
This command adds no rules of its own — that is the whole point of it.

## 3. Report

Say which track ran, how many cycles it took, and what the verifier said.
```

`skills/mjloop-leader/SKILL.md` — أضف قسماً بعد `3d`:

```markdown
### 3e. Running a track no command is named after

`/mjloop:run <track>` opens any track in `config.yaml`, including one this skill has
never heard of. Nothing changes: compose the roster from that track's own `required`,
`available` and `closing` sets, honour its `gate` and its `order` exactly as you would
the four above, and stop at its `max_cycles`.

The sections above name `edit`, `build`, `fix` and `plan` because those four have
commands and standing guidance. They are not the list of tracks that exist. If you find
yourself reasoning about which of the four a custom track "really is", stop: the track's
own sets already say what it runs, and the engine never learns an agent's name for
exactly this reason.
```

`TrackRunForm.vue` — حقلٌ وزرّ، يستدعي `send({ type: 'enqueue', command, story: null })` و`pane.setView('queue')` كما يفعل `Launcher.vue`.

حدّث `CLAUDE.md` و`README.md` و`docs/usage*.md` بسطر الأمر الجديد.

- [ ] **Step 4: شغّل كل شيء**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 5: الالتزام**

```bash
git add commands/ skills/ engine/ CLAUDE.md README.md docs/
git commit -m "feat: /mjloop:run — open any track by name

A track built from the dashboard had nothing to run it: the four commands
pin their track name in their own text. The leader gains the section that
says a custom track needs no new rules, only its own sets.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: التوثيق والبناء النهائي

**Files:**
- Modify: `docs/about.md`, `docs/about.ar.md`, `docs/usage.md`, `docs/usage.ar.md`, `skills/mjloop-extend/SKILL.md`
- Modify: `engine/dist/**` (بناء)

- [ ] **Step 1: حدّث `mjloop-extend`**

القسم «Adding an agent» يقول اليوم إن `.claude/agents/<name>.md` تُكتب بأداة Write. أضف أن تبويب الوكلاء في `/mjloop:web` يفعل الشيء نفسه خلف بابٍ محروس، وأن القيدين الباقيين لم يتغيّرا: العقد يبقى inline، والوكيل الذي لا يعرضه مسارٌ لا يُستدعى أبداً.

- [ ] **Step 2: حدّث دليل الاستخدام بالعربية والإنجليزية**

فقرة عن التبويبين، وسطر عن `/mjloop:run`.

- [ ] **Step 3: ابنِ والتزم**

Run: `cd engine && npm run build && npm test && npm run typecheck`
Expected: PASS

```bash
git add docs/ skills/ engine/dist/
git commit -m "docs: the agents and tracks tabs, and the generic run command

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## مراجعة الخطة على المواصفة

| قسم المواصفة | المهمّة |
|---|---|
| `store/agent-store.ts` | 1، 2 |
| `/api/agents` و`revisions.agents` | 3 |
| أبواب `agent.create/update/delete` والحرّاس الخمسة | 2 (الحصر بالاسم، البصمة، الحجب)، 4 (التشغيلة النشطة، الاستخدام في مسار) |
| توسيع الحارس على استيرادات `writes.ts` | 4 |
| `skill.agents` و`setAcceptanceAgents` | 5 |
| توسيع `SKILL_ACCEPTANCE_AGENTS` في المواضع الثلاثة | 5 |
| تبويب الوكلاء: الرأس، الاستخدام، المهارات، المحرّر، الاشتقاق | 6، 7، 8، 9 |
| فصل `collectConfigChanges` ونقل المسارات | 10 |
| `lib/trackgraph.ts` | 11 |
| مخطّط Vue Flow، حواف البوابة، الرفض عند السحب، منظور القائمة | 12 |
| `/mjloop:run` ونموذج التشغيل وقسم الوكيل الرئيسي | 13 |
| رموز الأخطاء الخمسة | 4 |
| المخاطر الأربع | 12 (الحزمة)، 5 (تزامن الأدوار)، 2 (الكتابة خارج `.mjloop`)، 12 (الوصولية) |

**فجوة واحدة وجدتُها وسددتُها**: المواصفة تشترط اختباراً يؤكّد تطابق مصادر الأدوار الثلاثة (الخطر 2). أضِفه إلى المهمّة 5 كخطوة سادسة:

```ts
// engine/tests/repo/ — أو حيث يعيش فحص التزامن بين المصادر في هذا المستودع
it('keeps the three copies of the routable-agents rule in step', async () => {
  const schema = await read('src/schemas/skill-acceptance.ts')
  const ops = await read('src/ops/run.ts')
  const browser = await read('src/web/app/lib/stories.ts')
  for (const [name, body] of [['schema', schema], ['ops', ops], ['browser', browser]] as const) {
    expect(body, name).toContain("['planner', 'builder', 'critic', 'verifier']")
  }
})
```

---

## التنفيذ

**الخطة محفوظة في `docs/superpowers/plans/2026-08-03-web-agents-and-tracks-tabs.md`.**
