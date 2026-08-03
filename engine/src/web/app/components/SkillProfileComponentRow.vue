<script setup lang="ts">
/**
 * `tpl-component`, ported: one component of the accepted map. `skillTags` is
 * the half of the join `SkillAcceptanceRow.vue`'s `components` is the other
 * half of — shown as one verbatim cell, not a chip list, because it is read
 * as a set rather than something actionable from here.
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'
import type { ProjectComponent } from '../types/protocol.js'

const props = defineProps<{ component: ProjectComponent }>()
const { t } = useI18n()
</script>

<template>
  <div class="component">
    <h3 data-slot="id"><Bdi :value="props.component.id" /></h3>
    <dl class="facts">
      <div class="fact"><dt>{{ t('config.componentRoot') }}</dt><dd data-slot="root"><Bdi :value="props.component.root" /></dd></div>
      <div class="fact"><dt>{{ t('config.componentTechnology') }}</dt><dd data-slot="technology"><Bdi :value="props.component.technology" /></dd></div>
      <div class="fact"><dt>verification.test</dt><dd data-slot="test"><template v-if="props.component.verification.test === null">{{ t('config.verifyUnset') }}</template><Bdi v-else :value="props.component.verification.test" /></dd></div>
      <div class="fact"><dt>verification.lint</dt><dd data-slot="lint"><template v-if="props.component.verification.lint === null">{{ t('config.verifyUnset') }}</template><Bdi v-else :value="props.component.verification.lint" /></dd></div>
      <div class="fact"><dt>verification.build</dt><dd data-slot="build"><template v-if="props.component.verification.build === null">{{ t('config.verifyUnset') }}</template><Bdi v-else :value="props.component.verification.build" /></dd></div>
      <div class="fact"><dt>{{ t('config.componentTags') }}</dt><dd data-slot="tags"><Bdi :value="props.component.skillTags.join(' ')" /></dd></div>
    </dl>
  </div>
</template>
