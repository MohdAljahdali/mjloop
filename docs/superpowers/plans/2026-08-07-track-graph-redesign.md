# خطة تنفيذ: إعادة تصميم رسم الـ Track — بطاقات غنية وسطح تحكّم كامل

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تحويل رسم الـ Track في لوحة mjloop web إلى canvas بأسلوب Zynflow الداكن: بطاقات وكلاء غنية (الوصف، الأدوات، الموديل، الدور، الحالة الحية)، تدفّق رأسي بالموجات، حواف معنونة، لوحة جانبية للإعدادات والتحكّم.

**Architecture:** نبني فوق `@vue-flow/core` الموجود و`lib/trackgraph.ts` الذي يحسب الطبقات. المنطق الجديد الخالص (اشتقاق محتوى البطاقة والحالة الحية) يذهب إلى ملف `lib/` جديد بلا DOM. `Tracks.vue` يبقى المالك الوحيد لـ `mutate` — كل مكوّن جديد يستقبله prop كما تفعل `SpecialistEditor.vue`.

**Tech Stack:** Vue 3.5 + TypeScript، `@vue-flow/core` 1.48.2، إضافتا `@vue-flow/background` و`@vue-flow/controls`، vitest (jsdom) للاختبارات.

**Spec:** `docs/superpowers/specs/2026-08-07-track-graph-redesign-design.md`

## Global Constraints

- كل الأوامر تُنفَّذ من `engine/`: الاختبارات `npm test`، الفحص `npm run typecheck`.
- **لا إحداثيات تُخزَّن أبدًا**: المواقع تُشتق من `layout()` في كل رسم؛ لا حقول جديدة في `config.yaml`، و`:nodes-draggable="false"` يبقى.
- **`mutate` في `Tracks.vue` هو الكاتب الوحيد للـ draft** — المكوّنات الجديدة تستقبله prop أو تُصدر أحداثًا إلى `Tracks.vue`؛ لا مكوّن يستورد `submit` أو `feed`.
- حافة الـ gate تُرسم ولا تُحدَّد ولا تُحذف (`selectable: false` يبقى).
- كل نص جديد للمستخدم يُضاف بمفتاح i18n في `en.json` **و** `ar.json` معًا (اختبار `locales.test.ts` يفرض التطابق)، والأسماء اللاتينية داخل نص عربي تُعرض عبر `Tx`/`Bdi` كما في `graphRefusal`.
- كثافة الاختبارات منخفضة: اختبارات المنطق الخالص في `lib/` + حراسة الرفض في المكوّنات؛ لا اختبارات مسارات سعيدة مكررة.
- تعليق التزامن بين `layersOf` و`dispatchWaves` لا يُمسّ — لا تغيير على قواعد الطبقات.
- ملف `TrackGraph.vue` الحالي يُطوَّر ولا يُستبدل؛ الأحداث `connect`/`disconnect`/`remove` القائمة ومستمعوها في `Tracks.vue` تبقى كما هي.
- الرسم هو التبويب الافتراضي أصلًا (`trackView = ref<'graph' | 'list'>('graph')`) — لا عمل مطلوب لهذا البند، لا تغيّره.
- بعد كل مهمة: commit، وفي نهاية الخطة `graphify update .` (قاعدة CLAUDE.md).

---

### Task 1: `lib/agentcard.ts` — اشتقاق محتوى البطاقة والحالة الحية (منطق خالص)

**Files:**
- Create: `engine/src/web/app/lib/agentcard.ts`
- Test: `engine/tests/web/lib-agentcard.test.ts`

**Interfaces:**
- Consumes: `AgentsView`/`AgentView` و`RosterView`/`StateSummary` من `../types/protocol.js`.
- Produces:
  - `interface CardInfo { name: string; description: string | null; tools: string[]; model: string | null; source: 'project' | 'plugin' | null }` — `source: null` تعني وكيلًا مذكورًا في الـ Track بلا ملف تعريف (بطاقة تحذير).
  - `function cardInfo(name: string, agents: AgentsView | null): CardInfo` — وكيل المشروع يظلّل وكيل الإضافة بنفس الاسم؛ `tools` تُقسَم على الفواصل وتُشذَّب.
  - `type LiveStatus = 'running' | 'landed' | 'idle'`
  - `function liveStatus(agent: string, trackName: string, state: Pick<StateSummary, 'status' | 'track'>, roster: RosterView | null): LiveStatus` — لا تكون إلا `idle` ما لم يكن `state.status === 'running'` و`state.track === trackName` و`roster !== null`؛ عندها: في `roster.landed` → `'landed'`، وإلا في `roster.selected` → `'running'`، وإلا `'idle'`.

- [ ] **Step 1: اكتب الاختبارات الفاشلة**

```ts
// engine/tests/web/lib-agentcard.test.ts
import { describe, expect, it } from 'vitest'
import { cardInfo, liveStatus } from '../../src/web/app/lib/agentcard.js'
import type { AgentsView, RosterView } from '../../src/web/app/types/protocol.js'

const AGENTS: AgentsView = {
  project: [{ name: 'builder', description: 'project builder', tools: 'Read, Edit', model: null, source: 'project' }],
  plugin: [
    { name: 'builder', description: 'plugin builder', tools: 'Read', model: 'sonnet', source: 'plugin' },
    { name: 'verifier', description: 'judges work', tools: null, model: null, source: 'plugin' },
  ],
  unreadable: [],
}

describe('cardInfo', () => {
  it('lets a project agent shadow the plugin agent of the same name', () => {
    const card = cardInfo('builder', AGENTS)
    expect(card.description).toBe('project builder')
    expect(card.source).toBe('project')
    expect(card.tools).toEqual(['Read', 'Edit'])
  })

  it('marks an agent with no definition file as missing, and survives a null view', () => {
    expect(cardInfo('ghost', AGENTS).source).toBeNull()
    expect(cardInfo('builder', null)).toEqual({ name: 'builder', description: null, tools: [], model: null, source: null })
  })

  it('reads empty tools as an empty list, not [""]', () => {
    expect(cardInfo('verifier', AGENTS).tools).toEqual([])
  })
})

describe('liveStatus', () => {
  const roster: RosterView = { cycle: 2, selected: ['builder', 'verifier'], landed: ['builder'] }

  it('is idle unless this exact track is the one running', () => {
    expect(liveStatus('builder', 'build', { status: 'running', track: 'fix' }, roster)).toBe('idle')
    expect(liveStatus('builder', 'build', { status: 'idle', track: 'build' }, roster)).toBe('idle')
    expect(liveStatus('builder', 'build', { status: 'running', track: 'build' }, null)).toBe('idle')
  })

  it('reads landed before selected, and an undrafted agent as idle', () => {
    const state = { status: 'running', track: 'build' } as const
    expect(liveStatus('builder', 'build', state, roster)).toBe('landed')
    expect(liveStatus('verifier', 'build', state, roster)).toBe('running')
    expect(liveStatus('scout', 'build', state, roster)).toBe('idle')
  })
})
```

- [ ] **Step 2: شغّل الاختبار وتأكد أنه يفشل**

Run: `cd engine && npx vitest run tests/web/lib-agentcard.test.ts`
Expected: FAIL — الملف `lib/agentcard.js` غير موجود.

- [ ] **Step 3: اكتب التنفيذ الأدنى**

```ts
// engine/src/web/app/lib/agentcard.ts
/**
 * Agentcard — the pure derivations behind the rich graph card: what a card
 * shows for an agent name (`cardInfo`), and how the running cycle colours it
 * (`liveStatus`). DOM-free and Vue-free like `trackgraph.ts` beside it.
 *
 * `cardInfo` resolves project-over-plugin because that is the shadowing rule
 * `readAgentsView` documents: the two directories are listed side by side and
 * never merged, precisely so a project agent of the same name wins.
 *
 * `liveStatus` reads only the intra-cycle signal that actually exists —
 * `RosterView`'s selected-vs-landed diff (see its own comment: stages
 * `execute`/`judge` are never written by the engine, so nothing here promises
 * one). Findings carry no agent name (`FindingSchema`), so a per-agent
 * findings state is deliberately absent.
 */
import type { AgentsView, RosterView, StateSummary } from '../types/protocol.js'

export interface CardInfo {
  name: string
  description: string | null
  tools: string[]
  model: string | null
  /** `null`: the track names an agent no definition file provides — drawn as a warning card, never hidden. */
  source: 'project' | 'plugin' | null
}

export function cardInfo(name: string, agents: AgentsView | null): CardInfo {
  const found = agents?.project.find((agent) => agent.name === name) ?? agents?.plugin.find((agent) => agent.name === name)
  if (found === undefined) return { name, description: null, tools: [], model: null, source: null }
  const tools = (found.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0)
  return { name, description: found.description.length > 0 ? found.description : null, tools, model: found.model, source: found.source }
}

export type LiveStatus = 'running' | 'landed' | 'idle'

export function liveStatus(
  agent: string,
  trackName: string,
  state: Pick<StateSummary, 'status' | 'track'>,
  roster: RosterView | null,
): LiveStatus {
  if (state.status !== 'running' || state.track !== trackName || roster === null) return 'idle'
  if (roster.landed.includes(agent)) return 'landed'
  if (roster.selected.includes(agent)) return 'running'
  return 'idle'
}
```

ملاحظة للمنفّذ: إن لم يكن `source` حقلًا على `AgentView` (تحقق من `AgentDoc` في `store/agent-store.ts` — الحقول `name`/`description`/`tools`/`model`/`source`/`file` بعد إسقاط `path`)، عدّل الاختبار والفixture إلى الحقول الفعلية التي يصدّرها `readAgentsView` وأبقِ العقد أعلاه كما هو.

- [ ] **Step 4: شغّل الاختبار وتأكد أنه ينجح**

Run: `cd engine && npx vitest run tests/web/lib-agentcard.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck ثم commit**

```bash
cd engine && npm run typecheck
git add src/web/app/lib/agentcard.ts tests/web/lib-agentcard.test.ts
git commit -m "feat(web): derive rich card info and live status for the track graph"
```

---

### Task 2: البطاقة الغنية والتدفّق الرأسي في `TrackGraph.vue`

**Files:**
- Modify: `engine/src/web/app/components/TrackGraph.vue`
- Modify: `engine/src/web/app/panels/Tracks.vue` (تمرير `agents`)
- Modify: `engine/src/web/app/styles/70-graph.css`
- Modify: `engine/src/web/app/locales/en.json`, `engine/src/web/app/locales/ar.json`
- Test: `engine/tests/web/panel-tracks.test.ts` (إضافة describe)

**Interfaces:**
- Consumes: `cardInfo` (Task 1)، `layout` القائمة.
- Produces: prop جديد على `TrackGraph`: `agents: AgentsView | null`. الإحداثيات تصبح رأسية: `{ x: index * 260, y: layer * 170 }` والمقابض `Position.Top`/`Position.Bottom`. بنية البطاقة (تعتمدها المهام اللاحقة): جذر `.graph-node` يحمل `data-graph-node="<name>"`، رأس `.graph-node-head` (الاسم + شارة الدور `.graph-node-role`)، جسم `.graph-node-body` (وصف `.graph-node-desc`، شرائح `.graph-node-tools`، شارات `.graph-node-meta`).

- [ ] **Step 1: اكتب اختبار المكوّن الفاشل**

أضف إلى `panel-tracks.test.ts` (اتبع أسلوب mount الموجود في الملف نفسه؛ إن كان الملف يركّب `Tracks.vue` كاملًا عبر feeds مزيفة فاتبع ذلك النمط، وإلا ركّب `TrackGraph` مباشرة كما يلي):

```ts
import { mount } from '@vue/test-utils'
import TrackGraph from '../../src/web/app/components/TrackGraph.vue'

const TRACK = { required: ['builder'], available: [], closing: [], order: [], max_cycles: 5 }
const AGENTS = {
  project: [],
  plugin: [{ name: 'builder', description: 'Writes the code and the tests.', tools: 'Read, Edit, Bash', model: 'sonnet', source: 'plugin' }],
  unreadable: [],
}

describe('the rich graph card', () => {
  it('shows the agent description, tools and model on the card, and a role badge', () => {
    const wrapper = mount(TrackGraph, { props: { track: TRACK, name: 'build', agents: AGENTS } })
    const card = wrapper.find('[data-graph-node="builder"]')
    expect(card.text()).toContain('Writes the code and the tests.')
    expect(card.text()).toContain('Bash')
    expect(card.text()).toContain('sonnet')
    expect(card.find('.graph-node-role').exists()).toBe(true)
  })

  it('draws an agent with no definition as a warning card, never hides it', () => {
    const wrapper = mount(TrackGraph, { props: { track: { ...TRACK, required: ['ghost'] }, name: 'build', agents: AGENTS } })
    const card = wrapper.find('[data-graph-node="ghost"]')
    expect(card.exists()).toBe(true)
    expect(card.classes()).toContain('node-missing')
  })
})
```

- [ ] **Step 2: شغّله وتأكد أنه يفشل**

Run: `cd engine && npx vitest run tests/web/panel-tracks.test.ts`
Expected: FAIL — البطاقة لا تحمل الوصف ولا `node-missing`.

- [ ] **Step 3: التنفيذ**

في `TrackGraph.vue`:

```ts
// props: أضف agents
const props = defineProps<{ track: Track; name: string; agents: AgentsView | null }>()

// الإحداثيات تصير رأسية — الموجة صف لا عمود
const nodes = computed(() =>
  geometry.value.nodes.map((node) => ({
    id: node.id,
    type: 'agent',
    position: { x: node.index * 260, y: node.layer * 170 },
    data: { agent: node.agent, list: node.list, cyclic: node.cyclic, card: cardInfo(node.agent, props.agents) },
  })),
)
```

وفي الـ template — المقابض تنقلب رأسيًا والبطاقة تتوسع:

```html
<template #node-agent="nodeProps">
  <div
    class="graph-node"
    :class="[`node-${nodeProps.data.list}`, { 'node-cyclic': nodeProps.data.cyclic, 'node-missing': nodeProps.data.card.source === null }]"
    :data-graph-node="nodeProps.id"
  >
    <Handle type="target" :position="Position.Top" />
    <div class="graph-node-head">
      <span class="graph-node-name">{{ nodeProps.data.agent }}</span>
      <span class="graph-node-role" :class="`role-${nodeProps.data.list}`">{{ t(`config.graph.role.${nodeProps.data.list}`) }}</span>
    </div>
    <div class="graph-node-body">
      <p v-if="nodeProps.data.card.description !== null" class="graph-node-desc">{{ nodeProps.data.card.description }}</p>
      <p v-else-if="nodeProps.data.card.source === null" class="graph-node-desc">{{ t('config.graph.missingAgent') }}</p>
      <div v-if="nodeProps.data.card.tools.length > 0" class="graph-node-tools">
        <span v-for="tool in nodeProps.data.card.tools" :key="tool" class="graph-node-tool">{{ tool }}</span>
      </div>
      <div class="graph-node-meta">
        <span v-if="nodeProps.data.card.model !== null" class="graph-node-model">{{ nodeProps.data.card.model }}</span>
        <span v-if="nodeProps.data.card.source === 'project'" class="graph-node-source">{{ t('config.graph.sourceProject') }}</span>
      </div>
    </div>
    <span v-if="nodeProps.data.cyclic" class="graph-node-cyclic-badge">{{ t('config.graph.cyclic') }}</span>
    <Handle type="source" :position="Position.Bottom" />
  </div>
</template>
```

في `Tracks.vue`: أضف feed للوكلاء بنمط `Agents.vue` نفسه ومرّره:

```ts
const agentsFeed = useFeed<AgentsView>({ dep: (state) => state.revisions.agents, path: () => '/api/agents' })
const agentsView = computed(() => agentsFeed.value.value)
```

```html
<TrackGraph ... :agents="agentsView" ... />
```

في `70-graph.css` (بعد قواعد `.graph-node` الحالية — عدّلها لا تكررها): عرض بطاقة ثابت `inline-size: 240px`، رأس بخلفية خفيفة حسب الدور (أخضر/أزرق/برتقالي بمتغيرات اللوحة)، `.graph-node-desc` بسطرين (`display: -webkit-box; -webkit-line-clamp: 2`)، شرائح أدوات صغيرة بإطار، `.node-missing` رمادي بإطار متقطع، وارفع `block-size` الحاوية `.track-graph` إلى `520px`.

مفاتيح i18n الجديدة (في `en.json` و`ar.json` معًا):
`config.graph.role.required` = "Required" / "مطلوب"، `config.graph.role.available` = "Available" / "متاح"، `config.graph.role.closing` = "Closing" / "ختامي"، `config.graph.missingAgent` = "No agent definition found" / "لا يوجد ملف تعريف لهذا الوكيل"، `config.graph.sourceProject` = "project" / "project".

- [ ] **Step 4: شغّل الاختبارات كلها**

Run: `cd engine && npm test`
Expected: PASS (بما فيها `locales.test.ts` و`lib-trackgraph*` القديمة — لم تتغير الهندسة، فقط تحويل الإحداثيات في المكوّن).

- [ ] **Step 5: commit**

```bash
git add -A engine/src/web/app engine/tests/web/panel-tracks.test.ts
git commit -m "feat(web): rich vertical agent cards on the track graph"
```

---

### Task 3: خلفية منقّطة، شريط تحكّم، وحواف معنونة

**Files:**
- Modify: `engine/package.json` (تبعيتان)
- Modify: `engine/src/web/app/components/TrackGraph.vue`
- Modify: `engine/src/web/app/styles/70-graph.css`
- Modify: `engine/src/web/app/locales/en.json`, `ar.json`
- Test: تعديل توقعات `engine/tests/web/assets.test.ts` إن كسرها استيراد CSS الجديد

- [ ] **Step 1: ثبّت الإضافتين**

```bash
cd engine && npm install @vue-flow/background@^1.3.2 @vue-flow/controls@^1.1.2
```

- [ ] **Step 2: التنفيذ**

في `TrackGraph.vue`:

```ts
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
```

```html
<VueFlow ...>
  <Background :gap="16" :size="1" pattern-color="var(--line)" />
  <Controls :show-interactive="false" position="bottom-right" />
  <template #node-agent="nodeProps">…</template>
</VueFlow>
```

الحواف تحمل عناوينها (`label` خاصية حافة قياسية في Vue Flow، وتُنسَّق بـ CSS):

```ts
const edges = computed(() =>
  geometry.value.edges.map((edge) =>
    edge.kind === 'gate'
      ? { id: edge.id, source: edge.source, target: edge.target, animated: false, selectable: false, class: 'edge-gate', label: t('config.graph.gateEdge', { agent: edge.source }) }
      : { id: edge.id, source: edge.source, target: edge.target, animated: false, class: 'edge-order', label: t('config.graph.orderEdge', { agent: edge.source }) },
  ),
)
```

(إن كانت `t()` في هذا المشروع لا تقبل params — راجع توقيعها في `composables/useI18n.ts` — فاستخدم المفتاح بلا حشو: `label: `${t('config.graph.after')} ${edge.source}``؛ التسمية داخل SVG لا تمر عبر `Tx`.)

مفاتيح i18n: `config.graph.after` = "after" / "بعد"، `config.graph.gateLabel` = "gate · proven by" / "بوابة · تفتحها".

CSS: أضف في `70-graph.css` تنسيق `.vue-flow__edge-text` (خط 10px، لون `var(--dim)`) و`.edge-gate .vue-flow__edge-text` برتقالي، واستورد `@vue-flow/controls/dist/style.css` بجوار الاستيرادين القائمين، ثم أعد تلوين أزرار الشريط بمتغيرات اللوحة (`--panel-2`, `--line`).

- [ ] **Step 3: شغّل الاختبارات**

Run: `cd engine && npm test`
Expected: PASS. إن أسقطها `assets.test.ts` (يفحص ما يُضمَّن في الحزمة) فاقرأ توقّعه وحدّثه بالأصول الجديدة الفعلية — لا تعطّل الاختبار.

- [ ] **Step 4: تحقق يدويًا ثم commit**

Run: `cd engine && npm run dev` وافتح صفحة Tracks — نقاط الخلفية وشريط التكبير والعناوين على الحواف ظاهرة.

```bash
git add -A engine
git commit -m "feat(web): dotted canvas, zoom controls and labelled edges on the track graph"
```

---

### Task 4: التحديد واللوحة الجانبية — إعدادات الـ Track، إضافة وكيل، تفاصيل البطاقة

**Files:**
- Create: `engine/src/web/app/components/TrackSidePanel.vue`
- Modify: `engine/src/web/app/components/TrackGraph.vue` (حدث `select`)
- Modify: `engine/src/web/app/panels/Tracks.vue` (التخطيط + الأسلاك)
- Modify: `engine/src/web/app/styles/70-graph.css`
- Modify: `engine/src/web/app/locales/en.json`, `ar.json`
- Test: `engine/tests/web/panel-tracks.test.ts`

**Interfaces:**
- Consumes: `cardInfo` (Task 1)، `mutate` prop بنمط `SpecialistEditor.vue`، `addOrderEdge`/بنية buckets من `lib/config.ts`.
- Produces:
  - `TrackGraph` يصدر حدثًا جديدًا `select: [{ agent: string | null }]` (نقرة عقدة → الاسم؛ نقرة الـ pane → `null`) عبر `@node-click` و`@pane-click`.
  - `TrackSidePanel.vue` props: `{ track: Track; name: string; agents: AgentsView | null; selected: string | null; mutate: (change: (model: Draft) => boolean | void) => void }` وحدث `clear-selection: []`.
  - كل `.track-graph` يلتف الآن في `.track-canvas-row` (اللوحة + الـ canvas جنبًا إلى جنب).

- [ ] **Step 1: اختبارات فاشلة** — أضف إلى `panel-tracks.test.ts`:

```ts
import TrackSidePanel from '../../src/web/app/components/TrackSidePanel.vue'

// نموذج draft مصغّر يطبَّق عليه mutate كما يفعل Tracks.vue تمامًا
function draftWith(track: Track) {
  return { specialists: [], tracks: { build: track } } as unknown as Draft
}

describe('the track side panel', () => {
  const BASE = { required: ['builder'], available: [], closing: [], order: [], max_cycles: 5 }

  it('adds an unused agent to available through mutate, and only available', async () => {
    const model = draftWith({ ...BASE, required: [...BASE.required] })
    const mutate = (change: (draft: Draft) => boolean | void) => void change(model)
    const wrapper = mount(TrackSidePanel, { props: { track: model.tracks['build'], name: 'build', agents: AGENTS, selected: null, mutate } })
    // AGENTS (fixture المهمة 2) يحوي builder فقط — أضف verifier إلى الـ fixture ليكون غير مدرج
    await wrapper.find('.side-add').trigger('click')
    expect(model.tracks['build'].available).toContain('verifier')
    expect(model.tracks['build'].required).toEqual(['builder'])
    expect(model.tracks['build'].closing).toEqual([])
  })

  it('moves a selected agent between roles through mutate, out of every other bucket', async () => {
    const model = draftWith({ ...BASE, required: [...BASE.required] })
    const mutate = (change: (draft: Draft) => boolean | void) => void change(model)
    const wrapper = mount(TrackSidePanel, { props: { track: model.tracks['build'], name: 'build', agents: AGENTS, selected: 'builder', mutate } })
    await wrapper.find('select').setValue('available')
    expect(model.tracks['build'].available).toContain('builder')
    expect(model.tracks['build'].required).not.toContain('builder')
  })

  it('never renders a gate editor — the gate is display-only on this panel', () => {
    const gated = { ...BASE, gate: { proven_by: 'builder', blocks: ['verifier'] } }
    const wrapper = mount(TrackSidePanel, { props: { track: gated, name: 'build', agents: AGENTS, selected: null, mutate: () => {} } })
    expect(wrapper.text()).toContain('builder')
    // المدخل الوحيد في كتلة الإعدادات هو max_cycles — لا حقول gate
    expect(wrapper.findAll('input').length).toBe(1)
  })
})
```

(عدّل fixture `AGENTS` من المهمة 2 بإضافة `verifier` إلى `plugin` إن لم يكن فيه. الرفضان — الدور لا يمس بقية القوائم، ولا محرر gate — هما الحارسان المهمان.)

- [ ] **Step 2: شغّلها وتأكد أنها تفشل**

Run: `cd engine && npx vitest run tests/web/panel-tracks.test.ts`

- [ ] **Step 3: التنفيذ**

`TrackGraph.vue` — التحديد:

```ts
const emit = defineEmits<{ /* القائمة الحالية */; select: [{ agent: string | null }] }>()
```

```html
<VueFlow ... @node-click="(e) => emit('select', { agent: e.node.id })" @pane-click="emit('select', { agent: null })">
```

`TrackSidePanel.vue` — ثلاث كتل، الثالثة تحلّ محل الأوليين عند التحديد:

```html
<aside class="track-side" :data-track-side="name">
  <template v-if="selected === null">
    <section class="side-block">
      <h3>{{ t('config.side.settings') }}</h3>
      <label>{{ t('config.trackMaxCycles') }}
        <input type="number" min="1" required :value="track.max_cycles" @change="onCycles" />
      </label>
      <p class="hint" v-if="track.gate !== undefined">
        {{ t('config.side.gate') }}: <Bdi>{{ track.gate.proven_by }}</Bdi> → <Bdi>{{ track.gate.blocks.join(', ') }}</Bdi>
      </p>
      <p class="hint" v-else>{{ t('config.side.noGate') }}</p>
      <p class="hint" v-if="track.map !== undefined">{{ t('config.side.map') }}: <Bdi>{{ track.map.drafted_by }}</Bdi></p>
      <p class="hint" v-else>{{ t('config.side.noMap') }}</p>
    </section>
    <section class="side-block">
      <!-- حقل الهدف وزر Run: المكوّن المشترك القائم، نفس مسار الإدراج في
           الطابور الذي يستخدمه TrackEditor.vue:257 — لا مسار إرسال جديد. -->
      <TrackRunForm :track="name" :enabled="true" />
    </section>
    <section class="side-block">
      <h3>{{ t('config.side.addAgent') }}</h3>
      <button v-for="agent in unused" :key="agent.name" type="button" class="side-add" @click="add(agent.name)">
        + <Bdi>{{ agent.name }}</Bdi> <span class="hint">{{ agent.description }}</span>
      </button>
      <p v-if="unused.length === 0" class="hint">{{ t('config.side.noneLeft') }}</p>
    </section>
  </template>
  <section v-else class="side-block side-detail">
    <h3><Bdi>{{ card.name }}</Bdi></h3>
    <p>{{ card.description ?? t('config.graph.missingAgent') }}</p>
    <div class="graph-node-tools"><span v-for="tool in card.tools" :key="tool" class="graph-node-tool">{{ tool }}</span></div>
    <p class="hint" v-if="card.model !== null">{{ t('config.side.model') }}: {{ card.model }}</p>
    <label>{{ t('config.side.role') }}
      <select :value="roleOf(selected)" @change="onRole">
        <option value="required">{{ t('config.graph.role.required') }}</option>
        <option value="available">{{ t('config.graph.role.available') }}</option>
        <option value="closing">{{ t('config.graph.role.closing') }}</option>
      </select>
    </label>
    <button type="button" @click="remove">{{ t('config.side.remove') }}</button>
    <button type="button" @click="emit('clear-selection')">{{ t('config.side.back') }}</button>
  </section>
</aside>
```

المنطق داخل المكوّن — كل تعديل عبر `props.mutate` حصريًا:

```ts
const card = computed(() => cardInfo(props.selected ?? '', props.agents))
const known = computed(() => new Set([...props.track.required, ...props.track.available, ...props.track.closing]))
const unused = computed(() => {
  const seen = new Set<string>()
  const all = [...(props.agents?.project ?? []), ...(props.agents?.plugin ?? [])]
  return all.filter((agent) => !known.value.has(agent.name) && !seen.has(agent.name) && (seen.add(agent.name), true))
})
function add(agentName: string): void {
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined || !Array.isArray(entry.available)) return false
    entry.available.push(agentName)
  })
}
function roleOf(agentName: string): 'required' | 'available' | 'closing' {
  if (props.track.required.includes(agentName)) return 'required'
  if (props.track.closing.includes(agentName)) return 'closing'
  return 'available'
}
function onRole(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as 'required' | 'available' | 'closing'
  const agentName = props.selected
  if (agentName === null) return
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined) return false
    for (const list of ['required', 'available', 'closing'] as const) {
      const bucket = entry[list]
      if (!Array.isArray(bucket)) continue
      const at = bucket.indexOf(agentName)
      if (at >= 0) bucket.splice(at, 1)
    }
    entry[next].push(agentName)
  })
}
```

(`onCycles` يطابق `onCyclesChange` في `TrackEditor.vue:53` — انسخ منطقه بحدوده. `remove` يعيد استخدام منطق `onGraphRemove` عبر حدث أو `mutate` مباشرة بنفس الأسطر.)

`Tracks.vue` — التخطيط والأسلاك:

```ts
const selectedByTrack = ref<Record<string, string | null>>({})
```

```html
<div v-for="entry in graphEntries" :key="entry.name" class="track-canvas-row">
  <TrackSidePanel
    :track="entry.track" :name="entry.name" :agents="agentsView"
    :selected="selectedByTrack[entry.name] ?? null" :mutate="mutate"
    @clear-selection="selectedByTrack[entry.name] = null"
  />
  <TrackGraph
    :track="entry.track" :name="entry.name" :agents="agentsView"
    @select="(params) => (selectedByTrack[entry.name] = params.agent)"
    @connect="(params) => onGraphConnect(entry.name, params)"
    @disconnect="(params) => onGraphDisconnect(entry.name, params)"
    @remove="(params) => onGraphRemove(entry.name, params)"
  />
</div>
```

CSS: `.track-canvas-row { display: flex; gap: 12px; }`، `.track-side { inline-size: 220px; flex-shrink: 0; }`، كتل `.side-block` بنمط بطاقات اللوحة (`--panel-2`، حد `--line`، `border-radius: var(--radius)`).

مفاتيح i18n الجديدة: `config.side.settings` = "Track settings" / "إعدادات المسار"، `config.side.addAgent` = "Add agent" / "إضافة وكيل"، `config.side.gate` = "Gate" / "البوابة"، `config.side.noGate` = "No gate" / "بلا بوابة"، `config.side.map` = "Map drafted by" / "الخريطة يصوغها"، `config.side.noMap` = "No map" / "بلا خريطة"، `config.side.noneLeft` = "Every agent is already on this track" / "كل الوكلاء مدرجون في هذا المسار"، `config.side.model` = "Model" / "الموديل"، `config.side.role` = "Role" / "الدور"، `config.side.remove` = "Remove from track" / "إزالة من المسار"، `config.side.back` = "Back" / "رجوع".

استيرادات المكوّن: `TrackRunForm` من `./TrackRunForm.vue` و`Bdi` من `./Bdi.vue` و`cardInfo` من `../lib/agentcard.js` — و`enabled` الحقيقي يُمرَّر prop من `Tracks.vue` (`:enabled="enabled"`) بدل `true` أعلاه إن طلب `TrackRunForm` ذلك.

- [ ] **Step 4: شغّل الاختبارات كلها**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add -A engine
git commit -m "feat(web): track side panel — settings, add-agent, and card detail with role control"
```

---

### Task 5: الحالة الحية على البطاقات أثناء run

**Files:**
- Modify: `engine/src/web/app/panels/Tracks.vue`
- Modify: `engine/src/web/app/components/TrackGraph.vue`
- Modify: `engine/src/web/app/styles/70-graph.css`
- Test: `engine/tests/web/panel-tracks.test.ts`

**Interfaces:**
- Consumes: `liveStatus` (Task 1)، `snapshot` من `stores/session.js` (يحمل `state` و`roster`).
- Produces: prop جديد على `TrackGraph`: `live: Record<string, LiveStatus> | null` — خريطة وكيل→حالة لهذا الـ track، و`null` عطّلها؛ أصناف `node-live-running` / `node-live-landed` على البطاقة.

- [ ] **Step 1: اختبار فاشل** — في `panel-tracks.test.ts`:

```ts
const TRACK2 = { required: ['builder', 'verifier'], available: [], closing: [], order: [], max_cycles: 5 }

it('pulses the running agent and marks the landed one, and nothing without a live map', () => {
  const live = { builder: 'running', verifier: 'landed' } as const
  const wrapper = mount(TrackGraph, { props: { track: TRACK2, name: 'build', agents: AGENTS, live } })
  expect(wrapper.find('[data-graph-node="builder"]').classes()).toContain('node-live-running')
  expect(wrapper.find('[data-graph-node="verifier"]').classes()).toContain('node-live-landed')
  const off = mount(TrackGraph, { props: { track: TRACK2, name: 'build', agents: AGENTS, live: null } })
  expect(off.find('[data-graph-node="builder"]').classes()).not.toContain('node-live-running')
})
```

- [ ] **Step 2: شغّله وتأكد أنه يفشل**

- [ ] **Step 3: التنفيذ**

`TrackGraph.vue`: `live?: Record<string, LiveStatus> | null` وفي `data` مرّر `status: props.live?.[node.agent] ?? 'idle'`، وعلى صنف الجذر أضف `` `node-live-${nodeProps.data.status}` `` عندما لا تكون `idle`.

`Tracks.vue`:

```ts
import { snapshot, submit } from '../stores/session.js'
const liveByTrack = computed(() => {
  const snap = snapshot.value
  if (snap === null) return {}
  const out: Record<string, Record<string, LiveStatus>> = {}
  for (const entry of graphEntries.value) {
    const map: Record<string, LiveStatus> = {}
    for (const agent of [...entry.track.required, ...entry.track.available, ...entry.track.closing]) {
      map[agent] = liveStatus(agent, entry.name, snap.state, snap.roster)
    }
    out[entry.name] = map
  }
  return out
})
```

ومرّر `:live="liveByTrack[entry.name] ?? null"`. (تحقق من شكل `snapshot` الفعلي في `stores/session.ts` — إن كان `held.value` قد يكون `null` قبل أول رسالة فالحارس أعلاه يكفي.)

CSS: `node-live-running` حدّ `--accent` مع `animation: pulse 1.6s ease-in-out infinite` (keyframes ظل خارجي يتنفس)، و`node-live-landed` حدّ أخضر ثابت، وداخل `@media (prefers-reduced-motion: reduce)` عطّل الـ animation وأبقِ اللون.

- [ ] **Step 4: شغّل الاختبارات ثم تحقق يدويًا**

Run: `cd engine && npm test`
ثم `npm run dev` مع run جارٍ (أو عدّل `.mjloop`-fixture محليًا) وتأكد من النبض.

- [ ] **Step 5: commit**

```bash
git add -A engine
git commit -m "feat(web): live per-agent cycle status on the track graph cards"
```

---

### Task 6: الإغلاق — فحص شامل، الرسم الافتراضي، تحديث الـ graph

**Files:**
- Modify: لا ملفات جديدة — تحقق وتوثيق فقط.

- [ ] **Step 1: تأكد أن الرسم هو الافتراضي**

`Tracks.vue:141` — `const trackView = ref<'graph' | 'list'>('graph')` موجودة أصلًا. لا تغيير؛ فقط تأكد أنها لم تُمسّ في المهام السابقة.

- [ ] **Step 2: الفحص الكامل**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS كلها.

- [ ] **Step 3: مراجعة بصرية أخيرة**

`npm run dev` — تحقق مقابل الـ spec: بطاقات غنية بالشارات، تدفق رأسي، حواف معنونة، gate برتقالية غير قابلة للحذف، لوحة جانبية تعمل بالإضافة/الدور/الإزالة، الرفض عند إغلاق دورة يظهر في البانر، والعرض في اللغة العربية سليم (أسماء لاتينية داخل `Bdi`).

- [ ] **Step 4: حدّث knowledge graph ثم commit ختامي**

```bash
cd /Volumes/SSD/Projects/loop && graphify update .
git add -A && git commit -m "chore: finish track graph redesign — verified against the spec"
```
