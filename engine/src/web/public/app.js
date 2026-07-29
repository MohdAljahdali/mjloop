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
import { routeFrom, startRouter } from './lib/router.js'
import { connect, send } from './net/socket.js'
import * as bus from './ui/bus.js'
import { flag, translateStatic, verbatim } from './ui/dom.js'
import { followQueue, mountPane, showJob, shownJob } from './ui/pane.js'
import { draw, register } from './ui/render.js'
import { drawRail, mountRail } from './ui/rail.js'
import { mountTabs, showTab } from './ui/tabs.js'
import { mountTerminal, refit, replace, write } from './ui/terminal.js'
import { mountHaltDialog } from './ui/dialog.js'
import { dismiss, mountToasts, runAction, toast } from './ui/toasts.js'
import { settle, submit } from './ui/writes.js'
import { mountConfig } from './panels/config.js'
import { mountEvidence } from './panels/evidence.js'
import { mountMemory } from './panels/memory.js'
import { mountLauncher } from './panels/launcher.js'
import { mountPlans } from './panels/plans.js'
import { mountQueue } from './panels/queue.js'
import { mountRun } from './panels/run.js'

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

const TABS = ['run', 'plans', 'evidence', 'memory', 'config']
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
mountRail(railSlots())
mountTerminal({
  host: /** @type {HTMLElement} */ (document.getElementById('terminal')),
  // Typing reaches the pty only while the live job is the one on screen.
  onData: (data) => {
    if (shownJob() !== null && shownJob() === activeJob) send({ type: 'input', data })
  },
  onResize: (cols, rows) => send({ type: 'resize', cols, rows }),
})

const pane = mountPane()
const haltDialog = mountHaltDialog()
const launcher = mountLauncher()
mountRun()
const plans = mountPlans()
const evidence = mountEvidence()
mountMemory()
mountConfig()
mountQueue()
register({ id: 'rail', node: /** @type {HTMLElement} */ (document.querySelector('.rail')), update: drawRail })
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
bus.on('build', (element) => enqueue(`/mjloop:build ${element.dataset['story'] ?? ''}`))
bus.on('open-plan', (element) => plans.toggle(element.dataset['plan'] ?? ''))
bus.on('close-plan', () => plans.close())
bus.on('open-run', (element) => evidence.toggle(element.dataset['run'] ?? ''))
bus.on('approve', () => plans.decide('approved'))
bus.on('request-changes', () => plans.decide('changes_requested'))
bus.on('reject', () => plans.decide('rejected'))
bus.on('requeue', (element) => plans.requeue(element.dataset['story'] ?? '', element.dataset['from'] ?? 'doing'))
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
bus.on('job-attach', (element) => send({ type: 'attach', jobId: element.dataset['job'] ?? '' }))
bus.on('view-session', () => pane.setView('session'))
bus.on('view-queue', () => pane.setView('queue'))
bus.on('pane-cycle', () => pane.cycle())
bus.on('pane-full', () => pane.toggleFull())
bus.on('toast-dismiss', (element) => dismiss(element))
bus.on('toast-action', (element) => runAction(element))
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
      draw(message.snapshot)
    } else if (message.type === 'output') {
      if (message.jobId === shownJob()) write(message.data)
    } else if (message.type === 'transcript') {
      showJob(message.jobId)
      replace(message.data)
      draw()
    } else if (message.type === 'notice') {
      toast(message.message)
    } else if (message.type === 'receipt') {
      settle(message)
    }
  },
})

/** @param {string} command */
function enqueue(command) {
  send({ type: 'enqueue', command })
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

await loadFallback()
picker.value = pickLocale()
await applyLocale(picker.value)
refit()
