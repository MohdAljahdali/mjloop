<script setup lang="ts">
/**
 * One row of the specialist telemetry table — `tpl-specialist`, ported. A
 * report and never a rule: nothing in the engine drafts or skips an agent
 * because of a number here.
 *
 * Every digit goes through `Bdi`, never `Intl` or a plain `t()` param: these
 * are read against the column heading, not as prose, and `Intl.NumberFormat
 * ('ar')` would render `4/1/0` as `٤/١/٠` beside a Latin agent name.
 */
import type { SpecialistRow } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ row: SpecialistRow }>()
</script>

<template>
  <div class="grid-row" role="row">
    <span role="cell"><code data-slot="agent"><Bdi :value="props.row.agent" /></code></span>
    <span role="cell" data-slot="mode"><Bdi :value="props.row.mode ?? '—'" /></span>
    <span role="cell" data-slot="drafted"><Bdi :value="String(props.row.drafted)" /></span>
    <span role="cell" data-slot="skipped"><Bdi :value="String(props.row.skipped)" /></span>
    <span role="cell" data-slot="landed"><Bdi :value="String(props.row.landed)" /></span>
    <span role="cell" data-slot="results">
      <Bdi :value="`${props.row.results.pass}/${props.row.results.fail}/${props.row.results.blocked}`" />
    </span>
    <span role="cell" data-slot="findings">
      <Bdi :value="`${props.row.findings.high}/${props.row.findings.medium}/${props.row.findings.low}`" />
    </span>
    <span role="cell" data-slot="runs"><Bdi :value="String(props.row.runs)" /></span>
    <span role="cell"><code data-slot="lastRun"><Bdi :value="props.row.last_seen ?? '—'" /></code></span>
  </div>
</template>
