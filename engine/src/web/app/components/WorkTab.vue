<script setup lang="ts">
/**
 * `tpl-worktab`, ported: one story tab in the work-tab strip. `Stories.vue`
 * owns the strip's keyboard navigation (`ui/worktabs.js`'s own reason for
 * being a second module beside `ui/tabs.js` — a working set needs
 * direction-aware arrow keys `ui/tabs.js` deliberately refused); this
 * component only draws one row and reports what was pressed.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ id: string; pinned: boolean; state: string | undefined; active: boolean }>()
defineEmits<{ select: [id: string]; pin: [id: string]; close: [id: string] }>()

const { t } = useI18n()
</script>

<template>
  <span class="worktab" role="presentation">
    <button
      type="button"
      class="worktab-open"
      role="tab"
      :data-tab="props.id"
      :data-story="props.id"
      data-slot="open"
      :aria-selected="props.active ? 'true' : 'false'"
      :tabindex="props.active ? '0' : '-1'"
      @click="$emit('select', props.id)"
    >
      <span class="worktab-label" data-slot="label"><Bdi :value="props.id" /></span>
      <span
        class="worktab-state"
        data-slot="state"
        :class="props.state === undefined ? undefined : `status-${props.state}`"
        :hidden="props.state === undefined"
      >{{ t(`story.status.${props.state ?? 'none'}`) }}</span>
    </button>
    <button
      type="button"
      class="worktab-pin"
      data-slot="pin"
      :class="props.pinned ? 'pinned-yes' : 'pinned-no'"
      :data-story="props.id"
      :aria-label="t(props.pinned ? 'story.tab.unpin' : 'story.tab.pin', { id: props.id })"
      @click="$emit('pin', props.id)"
    ></button>
    <button
      type="button"
      class="worktab-close"
      data-slot="close"
      :data-story="props.id"
      :hidden="props.pinned"
      :aria-label="t('story.tab.close', { id: props.id })"
      @click="$emit('close', props.id)"
    ></button>
  </span>
</template>
