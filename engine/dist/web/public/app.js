/**
 * The page. Vanilla on purpose — `engine` builds with `tsc` alone, and one
 * screen does not justify a toolchain.
 *
 * It owns every word the user reads. The server sends codes; translation
 * happens here and nowhere else, which is what makes a new language one JSON
 * file instead of an audit of the server.
 */

/** Adding a language: drop `locales/<code>.json` beside the others, add a line. */
const LOCALES = {
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
}
const FALLBACK = 'en'

const token = new URLSearchParams(location.search).get('t') ?? ''

let strings = {}
let fallbackStrings = {}
let lang = FALLBACK
let numbers = new Intl.NumberFormat(FALLBACK)
let times = new Intl.DateTimeFormat(FALLBACK, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function t(key, params) {
  const template = strings[key] ?? fallbackStrings[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name]
    if (value === undefined) return whole
    return typeof value === 'number' ? numbers.format(value) : String(value)
  })
}

/** A `{ code, params }` from the server. Its wording lives here. */
function say(message) {
  return message === null || message === undefined ? '' : t(message.code, message.params)
}

async function fetchLocale(code) {
  const response = await fetch(`locales/${code}.json?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

function pickLocale() {
  const forced = new URLSearchParams(location.search).get('lang')
  if (forced !== null && forced in LOCALES) return forced
  const saved = localStorage.getItem('mjloop.lang')
  if (saved !== null && saved in LOCALES) return saved
  for (const candidate of navigator.languages ?? []) {
    const base = candidate.split('-')[0]
    if (base in LOCALES) return base
  }
  return FALLBACK
}

async function setLocale(code) {
  lang = code in LOCALES ? code : FALLBACK
  strings = lang === FALLBACK ? fallbackStrings : await fetchLocale(lang).catch(() => ({}))
  numbers = new Intl.NumberFormat(lang)
  times = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  localStorage.setItem('mjloop.lang', lang)

  document.documentElement.lang = lang
  document.documentElement.dir = LOCALES[lang].dir
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n)
  }
  const input = document.getElementById('command')
  input.placeholder = t('command.placeholder')
  if (lastSnapshot !== null) render(lastSnapshot)
}

/* ── terminal ─────────────────────────────────────────────────────────── */

const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 10_000,
  theme: { background: '#000000', foreground: '#e6edf3' },
})
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('terminal'))

/** The job the terminal is showing. Not always the running one — you can read a finished job. */
let shown = null

term.onData((data) => {
  // Typing into a finished transcript would go to whatever is running now,
  // which is not what the person looking at it means.
  if (shown !== null && shown === activeJobId()) send({ type: 'input', data })
})

function refit() {
  try {
    fit.fit()
    send({ type: 'resize', cols: term.cols, rows: term.rows })
  } catch {
    /* not laid out yet */
  }
}
addEventListener('resize', refit)

/* ── socket ───────────────────────────────────────────────────────────── */

let socket = null
let lastSnapshot = null

function send(message) {
  if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function activeJobId() {
  return lastSnapshot?.session.jobId ?? null
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${scheme}://${location.host}/?t=${encodeURIComponent(token)}`)

  socket.addEventListener('open', () => {
    document.getElementById('offline').hidden = true
    refit()
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'snapshot') {
      const previous = activeJobId()
      lastSnapshot = message.snapshot
      // Follow the queue: when a new job starts, show it. Unless the user has
      // deliberately opened a finished transcript, in which case leave them there.
      const next = activeJobId()
      if (next !== null && next !== previous && (shown === previous || shown === null)) shown = next
      render(lastSnapshot)
    } else if (message.type === 'output') {
      if (message.jobId === shown) term.write(message.data)
    } else if (message.type === 'transcript') {
      shown = message.jobId
      term.reset()
      term.write(message.data)
      render(lastSnapshot)
    }
  })

  socket.addEventListener('close', () => {
    document.getElementById('offline').hidden = false
    // Retried rather than surfaced as an error: the usual cause is the server
    // restarting under a rebuild, and the page recovers on its own.
    setTimeout(connect, 1000)
  })
}

/* ── render ───────────────────────────────────────────────────────────── */

function row(key, value) {
  return `<div class="row"><span class="key">${escape(key)}</span><span class="val">${escape(value)}</span></div>`
}

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

function renderState(state) {
  const panel = document.getElementById('state-panel')
  if (!state.initialised) {
    panel.innerHTML = `<p class="empty">${escape(t('state.uninitialised'))}</p>`
    return
  }
  if (state.status === 'idle') {
    panel.innerHTML = `<p class="empty">${escape(t('state.idle'))}</p>`
    return
  }

  const parts = [row(t('state.track'), state.track ?? '—')]
  parts.push(
    row(
      t('state.cycle'),
      t('state.cycleOf', { cycle: state.cycle, max: state.max_cycles === null ? '?' : state.max_cycles }),
    ),
  )
  parts.push(row(t('state.stage'), `${t(`status.${state.status}`)} · ${t(`stage.${state.stage}`)}`))
  if (state.story !== null) parts.push(row(t('state.story'), state.story))
  if (state.goal !== null) parts.push(row(t('state.goal'), state.goal))
  parts.push(
    row(
      t('state.findings'),
      t('state.findingsCounts', {
        high: state.findings.high,
        medium: state.findings.medium,
        low: state.findings.low,
      }),
    ),
  )
  if (state.reproduction !== null) {
    parts.push(row('', t(state.reproduction.proven ? 'state.gate.open' : 'state.gate.shut')))
  }
  if (state.halt_reason !== null) parts.push(row(t('state.halted'), state.halt_reason))
  if (state.config_error !== null) {
    parts.push(`<p class="banner blocked">${escape(t('state.configError', { error: state.config_error }))}</p>`)
  }
  if (!state.design_system) {
    parts.push(`<p class="reason">${escape(t('state.designSystemMissing'))}</p>`)
  }
  panel.innerHTML = parts.join('')
}

function renderPlans(plans) {
  const host = document.getElementById('plans')
  if (plans.length === 0) {
    host.innerHTML = `<p class="empty">${escape(t('plans.empty'))}</p>`
    return
  }

  host.innerHTML = plans
    .map((plan) => {
      const approval = t(`plans.approval.${plan.approval ?? 'none'}`)
      const stories =
        plan.stories.length === 0
          ? `<p class="empty">${escape(t('plans.storiesEmpty'))}</p>`
          : `<ul class="stories">${plan.stories
              .map(
                (story) => `
                  <li class="story">
                    <span class="dot ${escape(story.status)}"></span>
                    <span title="${escape(story.title)}">${escape(story.id)}</span>
                    ${story.ui ? `<span class="tag">${escape(t('story.ui'))}</span>` : ''}
                    <button data-build="${escape(story.id)}" title="${escape(t('story.build'))}">+</button>
                  </li>`,
              )
              .join('')}</ul>`
      return `
        <div class="plan">
          <div class="plan-head">
            <span class="plan-id">${escape(plan.id)}</span>
            <strong>${escape(plan.title)}</strong>
            <span class="tag">${escape(approval)}</span>
          </div>
          ${stories}
        </div>`
    })
    .join('')
}

function renderQueue(snapshot) {
  const host = document.getElementById('queue')
  const jobs = snapshot.queue
  const queued = jobs.filter((job) => job.status === 'queued')
  const blocked = snapshot.session.blocked

  const list =
    jobs.length === 0
      ? `<p class="empty">${escape(t('queue.empty'))}</p>`
      : `<ul class="jobs">${jobs
          .slice()
          .reverse()
          .map(
            (job) => `
              <li class="job ${escape(job.status)}">
                <span class="cmd" title="${escape(job.command)}">${escape(job.command)}</span>
                <span class="st">${escape(t(`job.status.${job.status}`))}</span>
                ${
                  job.status === 'queued'
                    ? `<button data-cancel="${escape(job.id)}">${escape(t('job.cancel'))}</button>`
                    : `<button data-attach="${escape(job.id)}" title="${escape(t('job.view'))}">↗</button>`
                }
              </li>
              ${job.reason === null ? '' : `<li class="reason">${escape(say(job.reason))}</li>`}`,
          )
          .join('')}</ul>`

  const banner = blocked ? `<p class="banner blocked">${escape(t('queue.blockedBanner'))}</p>` : ''
  const actions = `
    <div class="queue-actions">
      ${blocked ? `<button id="resume">${escape(t('queue.resume'))}</button>` : ''}
      ${queued.length > 0 ? `<button id="clear">${escape(t('queue.clear'))}</button>` : ''}
    </div>`

  host.innerHTML = banner + list + actions
}

function renderSession(snapshot) {
  const running = snapshot.session.jobId
  document.getElementById('stop').hidden = running === null
  document.getElementById('terminal-empty').hidden = shown !== null
  document.getElementById('terminal').hidden = shown === null

  const job = snapshot.queue.find((entry) => entry.id === shown)
  const label = job === undefined ? '' : job.command
  const suffix = shown !== null && shown !== running ? ` — ${t('terminal.viewing')}` : ''
  document.getElementById('job-label').textContent = label + suffix

  const stalled = document.getElementById('stalled')
  if (snapshot.session.stalledSince === null) {
    stalled.hidden = true
  } else {
    stalled.hidden = false
    document.getElementById('stalled-text').textContent = t('session.stalled', {
      time: times.format(new Date(snapshot.session.stalledSince)),
    })
  }
}

function render(snapshot) {
  if (snapshot === null) return
  document.getElementById('project').textContent = snapshot.project
  renderState(snapshot.state)
  renderPlans(snapshot.plans)
  renderQueue(snapshot)
  renderSession(snapshot)
}

/* ── events ───────────────────────────────────────────────────────────── */

document.addEventListener('click', (event) => {
  const target = event.target.closest('button')
  if (target === null) return

  if (target.dataset.build !== undefined) {
    send({ type: 'enqueue', command: `/mjloop:build ${target.dataset.build}` })
  } else if (target.dataset.cancel !== undefined) {
    send({ type: 'cancel', jobId: target.dataset.cancel })
  } else if (target.dataset.attach !== undefined) {
    send({ type: 'attach', jobId: target.dataset.attach })
  } else if (target.id === 'stop') {
    send({ type: 'stop' })
  } else if (target.id === 'clear') {
    send({ type: 'clear' })
  } else if (target.id === 'resume') {
    send({ type: 'resume' })
  } else if (target.id === 'nudge') {
    send({ type: 'nudge' })
  }
})

document.getElementById('command-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = document.getElementById('command')
  const command = input.value.trim()
  if (command.length === 0) return
  send({ type: 'enqueue', command })
  input.value = ''
})

/* ── boot ─────────────────────────────────────────────────────────────── */

const picker = document.getElementById('lang')
picker.innerHTML = Object.entries(LOCALES)
  .map(([code, meta]) => `<option value="${code}">${escape(meta.name)}</option>`)
  .join('')
picker.addEventListener('change', () => void setLocale(picker.value))

fallbackStrings = await fetchLocale(FALLBACK).catch(() => ({}))
const initial = pickLocale()
picker.value = initial
await setLocale(initial)
connect()
refit()
