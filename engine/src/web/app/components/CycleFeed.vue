<script setup lang="ts">
/**
 * One open cycle's own document, fetched through `useFeed` — the Vue answer
 * to N concurrent revision-driven documents is N component instances, each
 * with its own scope-bound teardown, not one hand-rolled `Map` an owning
 * component prunes by hand. Mounted per cycle by `Evidence.vue`'s own
 * `v-for` over the open run's cycle list; unmounting it (closing the run, or
 * the run falling out of the list) is what retires its feed.
 *
 * Only the run's last cycle can still be written to, and only while that run
 * is the live one — `live` carries that fact in from the parent, which is
 * the one thing this component cannot derive from its own props alone (it
 * would need the snapshot's `state.run_id`, which is the run list's to
 * read, not one cycle's). Every earlier cycle directory is inert, so it is
 * fetched once and then follows `revisions.runs` rather than
 * `revisions.cycle` — otherwise an open run with eight cycles would issue
 * eight conditional GETs a second forever.
 */
import { computed } from 'vue'
import { useFeed } from '../composables/useFeed.js'
import type { CycleDetail } from '../types/protocol.js'
import CycleBlock from './CycleBlock.vue'

const props = defineProps<{ run: string; cycle: number; live: boolean }>()

const cycleFeed = useFeed<CycleDetail>({
  dep: (state) => `${props.run}:${props.cycle}:${props.live ? state.revisions.cycle : state.revisions.runs}`,
  path: () => `/api/runs/${encodeURIComponent(props.run)}/${props.cycle}`,
})
const detail = computed(() => cycleFeed.value.value)
</script>

<template>
  <CycleBlock v-if="detail !== null" :cycle="detail" />
</template>
