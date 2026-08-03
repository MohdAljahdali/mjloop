/**
 * Transient messages, and the only place an undo is offered.
 *
 * A toast holds a `Message` — a code and parameters — never a sentence. The
 * wording is resolved at render time, so a locale change while a toast is on
 * screen re-renders it in the new language.
 */
import { readonly, ref } from 'vue'
import type { Message } from '../../protocol.js'

export type ToastAction = { code: string; run: () => void }
export type Toast = { id: number; message: Message; action: ToastAction | null }

const held = ref<Toast[]>([])
let counter = 0

export function useToasts() {
  return {
    toasts: readonly(held) as Readonly<typeof held>,
    notify(message: Message, action?: ToastAction) {
      held.value = [...held.value, { id: ++counter, message, action: action ?? null }]
    },
    dismiss(id: number) {
      held.value = held.value.filter((toast) => toast.id !== id)
    },
  }
}
