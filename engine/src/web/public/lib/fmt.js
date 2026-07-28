/**
 * Numbers, clocks and durations, formatted for the active language.
 *
 * Everything here is *prose* formatting. Anything that is an identifier — a
 * story id, a run id, a path, a command — must not come through this module at
 * all; `Intl.NumberFormat('ar')` renders Arabic-Indic digits and `P001-S02`
 * would arrive on screen as `P٠٠١-S٠٢`.
 */
import { locale } from './i18n.js'

/** @type {{ key: string, format: Intl.DateTimeFormat } | null} */
let clockCache = null

/** @returns {Intl.DateTimeFormat} */
function clock() {
  const key = locale()
  if (clockCache === null || clockCache.key !== key) {
    clockCache = {
      key,
      format: new Intl.DateTimeFormat(key, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }
  }
  return clockCache.format
}

/**
 * A wall-clock time, or an empty string for a timestamp that is absent or
 * unparseable. Returning `''` rather than `Invalid Date` matters: these arrive
 * from files a person may have hand-edited.
 *
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function time(iso) {
  if (iso === null || iso === undefined) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : clock().format(at)
}

/**
 * How long a job ran, as a compact `1h 04m` / `3m 12s` / `9s`.
 *
 * Deliberately not localised into words: it sits in a dense row beside a
 * command, and the unit letters read the same at a glance in both directions.
 *
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 * @returns {string}
 */
export function duration(from, to) {
  if (from === null || from === undefined) return ''
  const start = new Date(from).getTime()
  const end = to === null || to === undefined ? Date.now() : new Date(to).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''

  const seconds = Math.floor((end - start) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${seconds}s`
}
