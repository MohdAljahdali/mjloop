<script setup lang="ts">
/**
 * `tpl-acceptance-record`, ported: one acceptance, joined to the library by
 * digest. The join's failure is the interesting case and has a slot of its
 * own — a repository cloned onto a machine whose library never imported the
 * package it names.
 */
import { useI18n } from '../composables/useI18n.js'
import { stamp } from '../lib/fmt.js'
import { shortDigest } from '../lib/skills.js'
import Bdi from './Bdi.vue'
import Tx from './Tx.vue'
import type { ProjectSkillAcceptance, SkillPackage } from '../types/protocol.js'

const props = defineProps<{ entry: { acceptance: ProjectSkillAcceptance; pkg: SkillPackage | null } }>()
const { t } = useI18n()
</script>

<template>
  <div class="component">
    <h3 data-slot="skillId"><Bdi :value="props.entry.acceptance.skillId" /></h3>
    <!-- The one thing a reader cannot work out from either list on its own. -->
    <p class="banner warn" data-slot="missing" :hidden="props.entry.pkg !== null">
      <Tx v-if="props.entry.pkg === null" key-name="skills.packageMissing" :params="{ digest: shortDigest(props.entry.acceptance.digest) }" />
    </p>
    <dl class="facts">
      <div class="fact"><dt>{{ t('skills.packageId') }}</dt><dd><code data-slot="packageId"><Bdi :value="props.entry.acceptance.packageId" /></code></dd></div>
      <div class="fact"><dt>{{ t('skills.digest') }}</dt><dd><code data-slot="digest"><Bdi :value="shortDigest(props.entry.acceptance.digest)" /></code></dd></div>
      <div class="fact"><dt>{{ t('skills.status') }}</dt><dd data-slot="status">{{ t(`skills.state.${props.entry.acceptance.status}`) }}</dd></div>
      <div class="fact"><dt>{{ t('skills.compatible') }}</dt><dd data-slot="compatible">{{ props.entry.acceptance.compatible ? t('skills.compatibleYes') : t('skills.compatibleNo') }}</dd></div>
      <div class="fact">
        <!-- An acceptance enabling no component selects nothing, whatever
             else it says. That is a sentence, not an empty cell. -->
        <dt>{{ t('skills.components') }}</dt>
        <dd data-slot="components"><template v-if="props.entry.acceptance.components.length === 0">{{ t('skills.none') }}</template><Bdi v-else :value="props.entry.acceptance.components.join(' ')" /></dd>
      </div>
      <div class="fact"><dt>{{ t('skills.agents') }}</dt><dd data-slot="agents"><Bdi :value="props.entry.acceptance.agents.join(' ')" /></dd></div>
      <div class="fact"><dt>{{ t('skills.tags') }}</dt><dd data-slot="tags"><Bdi :value="props.entry.acceptance.tags.join(' ')" /></dd></div>
      <div class="fact"><dt>{{ t('skills.updatePolicy') }}</dt><dd data-slot="updatePolicy">{{ t(`skills.update.${props.entry.acceptance.updatePolicy}`) }}</dd></div>
      <div class="fact">
        <dt>{{ t('skills.acceptedBy') }}</dt>
        <dd data-slot="acceptedBy"><Tx key-name="skills.acceptedRecord" :params="{ by: props.entry.acceptance.acceptedBy, at: stamp(props.entry.acceptance.acceptedAt) }" /></dd>
      </div>
    </dl>
  </div>
</template>
