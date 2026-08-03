/**
 * Numbers, clocks and durations, formatted for the active language.
 *
 * Everything here is *prose* formatting. Anything that is an identifier — a
 * story id, a run id, a path, a command — must not come through this module at
 * all; `Intl.NumberFormat('ar')` renders Arabic-Indic digits and `P001-S02`
 * would arrive on screen as `P٠٠١-S٠٢`.
 */
import { locale } from './i18n.js'

let clockCache: { key: string; format: Intl.DateTimeFormat } | null = null

function clock(): Intl.DateTimeFormat {
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
 */
export function time(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : clock().format(at)
}

let stampCache: { key: string; format: Intl.DateTimeFormat } | null = null

/**
 * A date and a time, for something that happened once and is on record — an
 * approval, a halt. `time()` is for "since when", which only needs a clock.
 */
export function stamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const key = locale()
  if (stampCache === null || stampCache.key !== key) {
    stampCache = { key, format: new Intl.DateTimeFormat(key, { dateStyle: 'medium', timeStyle: 'short' }) }
  }
  return stampCache.format.format(at)
}

/**
 * How long a job ran, as a compact `1h 04m` / `3m 12s` / `9s`.
 *
 * Deliberately not localised into words: it sits in a dense row beside a
 * command, and the unit letters read the same at a glance in both directions.
 */
export function duration(from: string | null | undefined, to: string | null | undefined): string {
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

/**
 * Milliseconds as `1.8s`, and an em dash while there is nothing to measure.
 *
 * Deliberately not `duration()` above, and for the same reason that one gives
 * for itself: this sits in a dense row beside a command and an exit code,
 * and the unit letter reads the same at a glance in both directions. One
 * decimal, because the number the cache argument turns on is under two
 * seconds — `panels/evidence.js`'s own `seconds()`, ported.
 */
export function verifyDuration(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`
}
