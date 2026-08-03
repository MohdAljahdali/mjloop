/**
 * Whether the halt dialog is open.
 *
 * Shared, module-level state — the same pattern `useTabs.ts`'s `active` ref
 * uses — because the control that opens it (`Rail.vue`'s halt button, on
 * screen in every tab) and the dialog itself (`App.vue`, a sibling of
 * `<main>` and deliberately outside its `<KeepAlive>`) are no longer in the
 * same component tree. A dialog living inside a kept-alive panel goes dead
 * the moment the reader switches tabs: the subtree detaches, the native
 * `<dialog>` loses its top-layer state, and nothing here would ever tell it
 * to re-open.
 */
import { ref } from 'vue'

const open = ref(false)

export function useHalt() {
  return {
    open,
    openHalt: (): void => void (open.value = true),
    closeHalt: (): void => void (open.value = false),
  }
}
