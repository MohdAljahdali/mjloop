<script setup lang="ts">
import { LOCALES, applyLocale, useI18n } from '../composables/useI18n.js'

const { t, locale } = useI18n()
</script>

<template>
  <label class="lang">
    <span>{{ t('lang.label') }}</span>
    <select name="lang" :value="locale" @change="applyLocale(($event.target as HTMLSelectElement).value)">
      <option v-for="(meta, code) in LOCALES" :key="code" :value="code">{{ meta.name }}</option>
    </select>
  </label>
</template>
