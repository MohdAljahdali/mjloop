<script setup lang="ts">
/**
 * `tpl-selection`, ported: one pinned `(component, agent)` row of the run's
 * manifest, plus the skills it selected.
 *
 * `skillIds` and `reasons` are index-aligned by a schema refinement, so this
 * pairs them by position without checking — the check is `SkillSelectionSchema`'s
 * and duplicating it here would be a second place it could be relaxed.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import type { SkillSelection } from '../types/protocol.js'
import SelectedSkillRow from './SelectedSkillRow.vue'

const props = defineProps<{ selection: SkillSelection; guidance: Record<string, string> }>()
const { t } = useI18n()

const rows = computed(() =>
  props.selection.skillIds.map((skillId, index) => ({
    skillId,
    reason: props.selection.reasons[index] ?? '',
    guidance: props.guidance[skillId] ?? '',
  })),
)
</script>

<template>
  <div class="component">
    <h4><code>{{ selection.component }}</code> · <code>{{ selection.agent }}</code></h4>
    <p v-if="selection.skillIds.length === 0" class="empty">{{ t('manifest.noneSelected') }}</p>
    <div>
      <SelectedSkillRow
        v-for="row in rows"
        :key="row.skillId"
        :skill-id="row.skillId"
        :reason="row.reason"
        :guidance="row.guidance"
      />
    </div>
  </div>
</template>
