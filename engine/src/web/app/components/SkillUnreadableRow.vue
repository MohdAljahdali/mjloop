<script setup lang="ts">
/**
 * `tpl-unreadable`, ported: a digest directory the walk could not turn into
 * a record. Shown rather than dropped — on a machine where `skills import`
 * can write, this is as likely to be an interrupted import as another
 * project's problem.
 */
import { shortDigest } from '../lib/skills.js'
import Bdi from './Bdi.vue'
import type { UnreadablePackage } from '../types/protocol.js'

const props = defineProps<{ entry: UnreadablePackage }>()
</script>

<template>
  <div class="grid-row" role="row">
    <span role="cell"><code data-slot="digest"><Bdi :value="shortDigest(props.entry.digest)" /></code></span>
    <!-- The store's own diagnosis, engine-authored, kept verbatim rather than
         turned into a key this page would have to keep in step with a
         message it does not own. -->
    <span role="cell" data-slot="reason"><Bdi :value="props.entry.reason" /></span>
  </div>
</template>
