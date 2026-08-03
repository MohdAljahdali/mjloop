/**
 * Whether the feature approval dialog is open — `useHalt.ts`, ported.
 *
 * Shared, module-level state for the same reason `useHalt.ts` keeps its own:
 * the control that opens it (`Features.vue`'s approve button, inside a
 * kept-alive panel) and the dialog itself (`App.vue`, a sibling of `<main>`
 * and deliberately outside its `<KeepAlive>`) must not be torn down together.
 * A native `<dialog>` living inside a kept-alive panel loses its top-layer
 * state the moment that panel's subtree detaches — `useHalt.ts`'s own
 * comment, and the reason this dialog follows the same shape.
 *
 * Unlike `useHalt.ts`, no subject is frozen here: the write this dialog
 * confirms is re-checked against `lib/featuredoc.ts`'s live document at the
 * moment of confirm, not against anything captured when it opened — see
 * `FeatureApproveDialog.vue`'s own comment for why.
 */
import { ref } from 'vue'

const open = ref(false)

export function useFeatureApprove() {
  return {
    open,
    openApprove: (): void => void (open.value = true),
    closeApprove: (): void => void (open.value = false),
  }
}
