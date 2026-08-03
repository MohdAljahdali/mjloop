<script setup lang="ts">
/**
 * `tpl-package`, ported: one package in this machine's shared library.
 * `audit.findings` includes the sandbox line — `writePackage` is only ever
 * reached from a passed audit, so there is no separate import report to draw
 * beside this.
 */
import { useI18n } from '../composables/useI18n.js'
import { stamp } from '../lib/fmt.js'
import { shortDigest } from '../lib/skills.js'
import Bdi from './Bdi.vue'
import FeatureAcceptanceRow from './FeatureAcceptanceRow.vue'
import type { SkillPackage } from '../types/protocol.js'

const props = defineProps<{ pkg: SkillPackage }>()
const { t } = useI18n()
</script>

<template>
  <div class="component">
    <h3 data-slot="name"><Bdi :value="props.pkg.skillName" /></h3>
    <p data-slot="description" dir="auto"><Bdi :value="props.pkg.description" /></p>
    <dl class="facts">
      <div class="fact"><dt>{{ t('skills.packageId') }}</dt><dd><code data-slot="packageId"><Bdi :value="props.pkg.packageId" /></code></dd></div>
      <div class="fact"><dt>{{ t('skills.digest') }}</dt><dd><code data-slot="digest"><Bdi :value="shortDigest(props.pkg.digest)" /></code></dd></div>
      <!-- The url, not the kind alone: "github" does not say *which*
           repository these bytes came from, and this is a supply-chain
           record. -->
      <div class="fact"><dt>{{ t('skills.source') }}</dt><dd data-slot="source"><Bdi :value="props.pkg.source.url" /></dd></div>
      <div class="fact"><dt>{{ t('skills.pinned') }}</dt><dd><code data-slot="revision"><Bdi :value="props.pkg.source.revision" /></code></dd></div>
      <div class="fact">
        <dt>{{ t('skills.license') }}</dt>
        <!-- A package with no SPDX identifier is the case worth naming: it is
             a package nobody can tell you the terms of. -->
        <dd data-slot="license"><template v-if="props.pkg.license.spdx === null">{{ t('skills.licenseUnknown') }}</template><Bdi v-else :value="props.pkg.license.spdx" /></dd>
      </div>
      <div class="fact"><dt>{{ t('skills.audit') }}</dt><dd data-slot="audit">{{ t(`skills.audit.${props.pkg.audit.state}`) }}</dd></div>
      <div class="fact">
        <!-- Declared, never resolved: the package says it wants these;
             nothing here has looked for them on this machine. -->
        <dt>{{ t('skills.executables') }}</dt>
        <dd data-slot="executables"><template v-if="props.pkg.dependencies.executables.length === 0">{{ t('skills.none') }}</template><Bdi v-else :value="props.pkg.dependencies.executables.join(' ')" /></dd>
      </div>
      <div class="fact">
        <dt>{{ t('skills.packages') }}</dt>
        <dd data-slot="packages"><template v-if="props.pkg.dependencies.packages.length === 0">{{ t('skills.none') }}</template><Bdi v-else :value="props.pkg.dependencies.packages.join(' ')" /></dd>
      </div>
      <div class="fact"><dt>{{ t('skills.tags') }}</dt><dd data-slot="tags"><Bdi :value="props.pkg.tags.join(' ')" /></dd></div>
      <div class="fact"><dt>{{ t('skills.imported') }}</dt><dd data-slot="imported"><Bdi :value="stamp(props.pkg.importedAt)" /></dd></div>
    </dl>
    <ul class="stories detail" data-slot="findings">
      <FeatureAcceptanceRow v-for="line in props.pkg.audit.findings" :key="line" :line="line" />
    </ul>
  </div>
</template>
