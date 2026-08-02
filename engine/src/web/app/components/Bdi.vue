<script setup lang="ts">
/**
 * An identifier, isolated from the sentence around it.
 *
 * Story ids, run ids, paths and commands go through here and never through a
 * `{n}` param: `Intl.NumberFormat('ar')` renders Arabic-Indic digits, so
 * `P001-S02` would become `P٠٠١-S٠٢`. The `dir` pin is the other half — an
 * unisolated Latin run inside an Arabic sentence drags the punctuation next to
 * it to the wrong end of the line.
 */
defineProps<{ value: string }>()
</script>

<template>
  <bdi dir="ltr">{{ value }}</bdi>
</template>
