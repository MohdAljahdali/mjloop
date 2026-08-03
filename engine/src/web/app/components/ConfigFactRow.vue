<script setup lang="ts">
/**
 * One row of a `<dl class="facts">` whose *label* is a `config.yaml` key
 * rather than a translated phrase — `tpl-fact`, as `Config.vue` uses it for
 * `verify:`'s own commands and policy. Distinct from `FactRow.vue`, whose
 * label is always `t(label)`: here the label is the identifier itself
 * (`verify.test`, `verify.timeout_ms`), so it goes through `Bdi` and never
 * through translation — the exact distinction `config.js`'s own
 * `factRow()` draws (`verbatim(label, key)`).
 */
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

defineProps<{ configKey: string; value: string | null }>()
const { t } = useI18n()
</script>

<template>
  <div class="fact">
    <dt><Bdi :value="configKey" /></dt>
    <!-- Unset is worth saying out loud, not a blank cell: this string is
         injected verbatim into every agent brief, and an agent that cannot
         verify is one the engine is forbidden to work around. -->
    <dd><Bdi v-if="value !== null" :value="value" /><template v-else>{{ t('config.verifyUnset') }}</template></dd>
  </div>
</template>
