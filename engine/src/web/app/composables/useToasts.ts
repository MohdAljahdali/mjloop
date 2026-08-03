/**
 * Transient messages, and the only place an undo is offered.
 *
 * A toast holds a `Message` — a code and parameters — never a sentence. The
 * wording is resolved at render time, so a locale change while a toast is on
 * screen re-renders it in the new language. `AnnouncedMessage`, not `Message`,
 * because a toast also carries `session.ts`'s own `ClientCode` (`write.offline`)
 * — a write refused before it reached the wire is announced the same way a
 * refused receipt is.
 */
import { readonly, ref } from 'vue'
import type { AnnouncedMessage } from '../stores/session.js'

export type ToastAction = { code: string; run: () => void }
export type Toast = { id: number; message: AnnouncedMessage; action: ToastAction | null }

/**
 * How long an actionless toast stays. `public/ui/toasts.js:16,56` — long
 * enough to read a sentence, short enough not to stack.
 */
const LIFETIME_MS = 8000

const held = ref<Toast[]>([])
let counter = 0
/** Pending self-removal timers, keyed on toast id — cancelled on manual dismiss. */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function remove(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
  held.value = held.value.filter((toast) => toast.id !== id)
}

export function useToasts() {
  return {
    toasts: readonly(held) as Readonly<typeof held>,
    notify(message: AnnouncedMessage, action?: ToastAction) {
      const id = ++counter
      held.value = [...held.value, { id, message, action: action ?? null }]
      // A toast that only *says* something goes away on its own. One that
      // offers an action stays until it is used or dismissed: an Undo the
      // reader has to notice, read and reach for in eight seconds is an
      // Undo that is not really there — `toasts.js:53-56`'s own reasoning.
      if (action === undefined) {
        timers.set(
          id,
          setTimeout(() => remove(id), LIFETIME_MS),
        )
      }
    },
    dismiss(id: number) {
      remove(id)
    },
  }
}
