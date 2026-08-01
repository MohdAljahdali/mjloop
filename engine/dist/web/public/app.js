/**
 * Boot. Nothing else.
 *
 * Every behaviour lives in a module: `lib/` is DOM-free and node-testable,
 * `ui/` owns the retained-DOM layer, `net/` owns the socket, `panels/` own one
 * tab each. This file wires them together once and gets out of the way.
 */
import { installToken } from './lib/api.js'
import { direction, installLocales, loadFallback, locale, pickLocale, setLocale } from './lib/i18n.js'
import { installStorage, read as prefs, write as remember } from './lib/local.js'
import { mountPlanDoc } from './lib/plandoc.js'
import { routeFrom, startRouter } from './lib/router.js'
import { ready } from './lib/stories.js'
import { connect, send } from './net/socket.js'
import * as bus from './ui/bus.js'
import { attr, flag, label, phrase, translateStatic, verbatim } from './ui/dom.js'
import { followQueue, mountPane, showJob, shownJob } from './ui/pane.js'
import { draw, register } from './ui/render.js'
import { drawRail, mountRail } from './ui/rail.js'
import { mountTabs, showTab } from './ui/tabs.js'
import { mountTerminal, refit, replace, write } from './ui/terminal.js'
import { mountHaltDialog } from './ui/dialog.js'
import { dismiss, mountToasts, runAction } from './ui/toasts.js'
import { close as closeNotifications, drawNoticeFeed, mountNotifications, notify, toggle as toggleNotifications } from './ui/notifications.js'
import { settle, submit } from './ui/writes.js'
import { mountConfig } from './panels/config.js'
import { mountEvidence } from './panels/evidence.js'
import { mountFeatures } from './panels/features.js'
import { mountMemory } from './panels/memory.js'
import { mountLauncher } from './panels/launcher.js'
import { mountPlans } from './panels/plans.js'
import { mountQueue } from './panels/queue.js'
import { mountRun } from './panels/run.js'
import { mountStories } from './panels/stories.js'
import { mountSkills } from './panels/skills.js'

/**
 * Adding a language: drop `locales/<code>.json` beside the others, add a line.
 *
 * Kept as a literal in this file, with two-space keys and a closing brace at
 * column 0, because `locales.test.ts` reads it as source text — a locale file
 * nobody registered is a translation the user cannot pick, and that test is
 * what catches it.
 *
 * @type {import('./lib/i18n.js').LocaleRegistry}
 */
const LOCALES = {
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
}
const FALLBACK = 'en'

const TABS = ['run', 'plans', 'stories', 'features', 'skills', 'evidence', 'memory', 'config']
const token = new URLSearchParams(location.search).get('t') ?? ''

/** The running job, as of the last snapshot. */
let activeJob = /** @type {string | null} */ (null)
/** The run id on record, so a halt names the run the user was actually looking at. */
let currentRun = /** @type {string | null} */ (null)

installStorage(localStorage)
installToken(token)
installLocales(LOCALES, FALLBACK, {
  load: async (code) => {
    const response = await fetch(`locales/${code}.json?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(String(response.status))
    return response.json()
  },
  saved: () => prefs().lang,
  save: (code) => void remember({ lang: code }),
  preferred: () => navigator.languages ?? [],
  forced: () => new URLSearchParams(location.search).get('lang'),
})

const picker = /** @type {HTMLSelectElement} */ (document.getElementById('lang'))
for (const [code, meta] of Object.entries(LOCALES)) {
  const option = document.createElement('option')
  option.value = code
  option.textContent = meta.name
  picker.append(option)
}

mountToasts(/** @type {HTMLElement} */ (document.getElementById('toasts')))
mountNotifications({
  toggle: /** @type {HTMLElement} */ (document.getElementById('notice-toggle')),
  count: /** @type {HTMLElement} */ (document.getElementById('notice-count')),
  panel: /** @type {HTMLElement} */ (document.getElementById('notice-panel')),
  empty: /** @type {HTMLElement} */ (document.getElementById('notice-empty')),
  list: /** @type {HTMLElement} */ (document.getElementById('notice-list')),
  more: /** @type {HTMLElement} */ (document.getElementById('notice-more')),
})
mountRail(railSlots())
mountTerminal({
  host: /** @type {HTMLElement} */ (document.getElementById('terminal')),
  // Typing reaches the pty only while the live job is the one on screen.
  onData: (data) => {
    if (shownJob() !== null && shownJob() === activeJob) send({ type: 'input', data })
  },
  onResize: (cols, rows) => send({ type: 'resize', cols, rows }),
})

/**
 * The open plan's document, installed before the panels that read it.
 *
 * Order matters: installing clears the subscriber list, so a panel that
 * subscribed first would be silently unsubscribed and its list would sit at
 * whatever the first frame drew.
 *
 * Ticked against `.tabs` rather than from a panel because `ui/render.js` skips
 * a hidden one: the plan detail and the story list beside it each read this
 * document while the other's tab is closed. The same reason the two navigation
 * counts live here.
 */
const planDoc = mountPlanDoc()

const pane = mountPane()
const haltDialog = mountHaltDialog()
const launcher = mountLauncher()
mountRun()
const plans = mountPlans()
const stories = mountStories()
const features = mountFeatures()
mountSkills()
const evidence = mountEvidence()
mountMemory()
const config = mountConfig()
mountQueue()
register({ id: 'rail', node: /** @type {HTMLElement} */ (document.querySelector('.rail')), update: drawRail })
// Ticked against `.top`, the whole header, rather than the panel this feed
// opens: the panel starts `hidden`, and `ui/render.js` skips a hidden node —
// a feed registered against the thing it has to be able to unhide would never
// get the chance to. `.top` holds the banners and the rail too, both already
// on screen in every tab, so this costs nothing extra to stay visible.
register({
  id: 'notifications',
  node: /** @type {HTMLElement} */ (document.querySelector('.top')),
  update: drawNoticeFeed,
})
register({
  id: 'plandoc',
  node: /** @type {HTMLElement} */ (document.querySelector('.tabs')),
  update: (snapshot) => planDoc.update(snapshot),
})
/**
 * The two numbers on the navigation.
 *
 * Wired here rather than inside `ui/rail.js` because `app.js` is the file that
 * already knows both — the readiness rule itself lives in `lib/stories.js`, so
 * borrowing it is no longer the layering problem it was when it belonged to a
 * panel. It stays registered against `.tabs`, which is on screen whatever tab
 * is open: a count inside a panel is a count that stops updating when the panel
 * closes.
 */
register({
  id: 'nav',
  node: /** @type {HTMLElement} */ (document.querySelector('.tabs')),
  update: (snapshot) => {
    badge(rail('navReady'), tab('tab-stories'), ready(snapshot.plans).length, 'tabs.readyCount')
    badge(rail('navGuard'), tab('tab-run'), snapshot.state.findings.high, 'tabs.highCount')
  },
})
register({
  id: 'chrome',
  node: /** @type {HTMLElement} */ (document.querySelector('.brand')),
  update: (snapshot) => verbatim(/** @type {HTMLElement} */ (document.getElementById('project')), snapshot.project),
})

mountTabs(TABS)
startRouter(
  {
    hash: () => location.hash,
    setHash: (hash) => void (location.hash = hash),
    onChange: (fn) => addEventListener('hashchange', fn),
  },
  TABS,
  'run',
  showTab,
)

bus.on('stop', () => send({ type: 'stop' }))
bus.on('resume', () => send({ type: 'resume' }))
bus.on('clear', () => send({ type: 'clear' }))
bus.on('nudge', () => send({ type: 'nudge' }))
bus.on('story-run', (element) => {
  const story = element.dataset['story'] ?? ''
  enqueue(`/mjloop:build ${story}`, story === '' ? null : story)
})
bus.on('open-plan', (element) => plans.toggle(element.dataset['plan'] ?? ''))
bus.on('close-plan', () => plans.close())
bus.on('open-run', (element) => evidence.toggle(element.dataset['run'] ?? ''))
bus.on('open-feature', (element) => features.toggle(element.dataset['feature'] ?? ''))
bus.on('close-feature', () => features.close())
// Approving a brief is the one write on this page with no inverse: the store
// refuses to touch an approved revision ever again. Hence a dialog, unlike the
// plan gate two lines above, which can be re-decided.
bus.on('feature-approve', () => features.ask())
bus.on('feature-cancel', () => features.dismiss())
bus.on('feature-confirm', () => features.confirm())
bus.on('approve', () => plans.decide('approved'))
bus.on('request-changes', () => plans.decide('changes_requested'))
bus.on('reject', () => plans.decide('rejected'))
bus.on('story-requeue', (element) => stories.requeue(element.dataset['story'] ?? '', element.dataset['from'] ?? 'doing'))
bus.on('story-tab', (element) => stories.openTab(element.dataset['story'] ?? ''))
bus.on('story-tab-close', (element) => stories.closeTab(element.dataset['story'] ?? ''))
bus.on('story-tab-pin', (element) => stories.pinTab(element.dataset['story'] ?? ''))
bus.on('story-tab-reopen', () => stories.reopenTab())
bus.on('config-save', () => config.save())
bus.on('config-reset', () => config.reset())
// The structured `specialists:` and `tracks:` editors. Every one of these
// mutates the panel's draft and nothing else — the save button is still the
// only thing that reaches the server.
bus.on('specialist-add', () => config.specialistAdd())
bus.on('specialist-remove', (element) => config.specialistRemove(element))
bus.on('track-add', () => config.trackAdd())
bus.on('track-remove', (element) => config.trackRemove(element))
bus.on('track-duplicate', (element) => config.trackDuplicate(element))
bus.on('agent-add', (element) => config.agentAdd(element))
bus.on('agent-remove', (element) => config.agentRemove(element))
bus.on('new-plan', (element) => {
  // A form, but the same execution path as everything else: it composes a loop
  // command and enqueues it.
  const field = /** @type {HTMLInputElement} */ (element.querySelector('#new-plan'))
  const idea = field.value.trim()
  if (idea.length === 0) return
  enqueue(`/mjloop:plan ${idea}`)
  field.value = ''
})
bus.on('job-cancel', (element) => send({ type: 'cancel', jobId: element.dataset['job'] ?? '' }))
bus.on('job-attach', (element) => {
  send({ type: 'attach', jobId: element.dataset['job'] ?? '' })
  // The transcript this asks for lands in `#view-session-body`, which is
  // hidden whenever the pane is `collapsed` (40-terminal.css:170-173) or its
  // view is `queue` (`ui/pane.js`'s `applyView`) — both true right now for a
  // reader who has not yet had a job open the pane, or who is looking at the
  // Queue tab, and both silent: the frame goes up, `shownJob()` changes, and
  // nothing on screen does. `setView` and `reveal` cover the two hiding
  // places; `reveal` is not `follow` because this press, unlike a job simply
  // starting, is the reader's own request and must win even over a height
  // they chose deliberately.
  pane.setView('session')
  pane.reveal()
})
bus.on('view-session', () => pane.setView('session'))
bus.on('view-queue', () => pane.setView('queue'))
bus.on('pane-cycle', () => pane.cycle())
bus.on('pane-full', () => pane.toggleFull())
bus.on('toast-dismiss', (element) => dismiss(element))
bus.on('toast-action', (element) => runAction(element))
bus.on('notice-toggle', () => toggleNotifications())
bus.on('notice-close', () => closeNotifications())
// Halt and Stop are not the same thing and never share a control: Stop kills
// the pty, halt writes HALT.md and only then closes the session.
bus.on('halt', () => haltDialog.open(currentRun))
bus.on('halt-cancel', () => haltDialog.close())
bus.on('halt-confirm', () => {
  const asked = haltDialog.take()
  if (asked !== null) submit({ kind: 'halt', run: asked.run, reason: asked.reason })
})
bus.on('enqueue', () => {
  const command = launcher.read()
  if (command.length === 0) return
  enqueue(command)
  launcher.clear()
})
bus.install(document)
picker.addEventListener('change', () => void applyLocale(picker.value))

connect({
  token,
  onStatus: (online) => flag(rail('offlineBanner'), 'hidden', online),
  onMessage: (message) => {
    if (message.type === 'snapshot') {
      const previous = activeJob
      activeJob = message.snapshot.session.jobId
      currentRun = message.snapshot.state.run_id
      followQueue(previous, activeJob)
      // Work opens the pane it needs. Nothing closes it again on its own, and
      // nothing moves it at all once the reader has set a height themselves.
      if (previous === null && activeJob !== null) pane.follow()
      draw(message.snapshot)
    } else if (message.type === 'output') {
      if (message.jobId === shownJob()) write(message.data)
    } else if (message.type === 'transcript') {
      showJob(message.jobId)
      replace(message.data)
      draw()
    } else if (message.type === 'notice') {
      notify(message.message)
    } else if (message.type === 'receipt') {
      settle(message)
    }
  },
})

/**
 * @param {string} command
 * @param {string | null} [story] The story this command is building, if it is.
 */
function enqueue(command, story = null) {
  // Named rather than inferred. A story tab finds its own job by this field;
  // string-matching the command back out would also match a hand-typed line and
  // would miss a `/mjloop:fix` working on the same story.
  send({ type: 'enqueue', command, story })
  // Show what just happened to it. A command that vanishes into an unseen queue
  // is the single most common way this page used to look broken.
  pane.setView('queue')
}

/** @param {string} code */
async function applyLocale(code) {
  await setLocale(code)
  document.documentElement.lang = locale()
  document.documentElement.dir = direction()
  translateStatic(document)
  // A locale change moves no snapshot field, so the repaint has to be asked for.
  draw()
}

/** @returns {Record<string, HTMLElement>} */
function railSlots() {
  /** @type {Record<string, HTMLElement>} */
  const slots = {}
  for (const node of document.querySelectorAll('[data-rail]')) {
    if (node instanceof HTMLElement && node.dataset['rail'] !== undefined) slots[node.dataset['rail']] = node
  }
  return slots
}

/**
 * @param {string} name
 * @returns {HTMLElement}
 */
function rail(name) {
  return /** @type {HTMLElement} */ (document.querySelector(`[data-rail="${name}"]`))
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function tab(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id))
}

/**
 * A count on a navigation row, and the sentence that says what it counts.
 *
 * The digits are `aria-hidden` and the sentence goes on the anchor's `title`: a
 * bare number announced after a view's name is a riddle, and the view already
 * has a perfectly good accessible name.
 *
 * @param {HTMLElement} node
 * @param {HTMLElement} anchor
 * @param {number} count
 * @param {string} key
 */
function badge(node, anchor, count, key) {
  // A count, so it is a number the interface is talking about and gets the
  // reader's own digits — not an identifier like `P001-S02`.
  phrase(node, 'tabs.number', { n: count })
  flag(node, 'hidden', count === 0)
  if (count === 0) attr(anchor, 'title', null)
  else label(anchor, 'title', key, { n: count })
}

await loadFallback()
picker.value = pickLocale()
await applyLocale(picker.value)
refit()
