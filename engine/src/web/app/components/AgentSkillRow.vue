<script setup lang="ts">
/**
 * One accepted skill, as a row on an agent's card: is this agent one of the
 * ones the acceptance routes to, and a checkbox to change that.
 *
 * `SkillAcceptanceRow.vue`'s `agents` fact, turned into a control — but this
 * component may only ever send the one field `web/writes.ts`'s `skill.agents`
 * door accepts: `write.ts:257`'s schema has no slot for `status`,
 * `components` or the package `digest`, so there is nothing here to reach for
 * beyond `agents` even by accident.
 *
 * Two digests travel through `props.entry` and only one may ever reach the
 * write: `entry.digest` is the *package* content hash (`skills.digest` on
 * `SkillAcceptanceRow.vue`, joined against the library) — sent here it would
 * be silently checked against the wrong record and refused as stale forever,
 * since `setAcceptanceAgents` compares it to `recordDigest`, never `digest`
 * (`web/read.ts`'s `AcceptanceView` header spells out why the two are named
 * apart). `entry.recordDigest` is the one this row actually sends: the hash
 * over the acceptance record itself, computed fresh into every `/api/skills`
 * answer, which is exactly the compare-and-swap token the door checks inside
 * its lock.
 *
 * No dialog sits between the click and the write — unlike
 * `useAgentDelete.ts`'s subject, there is no gap for a concurrent snapshot to
 * land in: the checkbox's own `change` handler reads `props.entry` at the
 * instant it fires, composes the whole new `agents` array in the same tick,
 * and calls `submit()` before Vue ever re-renders this row from a newer feed
 * value. Toggling the box back is the undo — the reversible case `submit()`'s
 * own header says needs no confirmation dialog at all.
 */
import { computed } from 'vue'
import { submit } from '../stores/session.js'
import type { AcceptanceView } from '../types/protocol.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ entry: AcceptanceView; agentName: string }>()

const checked = computed(() => props.entry.agents.includes(props.agentName))

function toggle(event: Event): void {
  const wanted = (event.target as HTMLInputElement).checked
  const rest = props.entry.agents.filter((name) => name !== props.agentName)
  const agents = wanted ? [...rest, props.agentName] : rest
  submit({ kind: 'skill.agents', skill: props.entry.skillId, digest: props.entry.recordDigest, agents })
}
</script>

<template>
  <label class="check-field" :data-skill="props.entry.skillId">
    <input type="checkbox" :checked="checked" @change="toggle" />
    <span><Bdi :value="props.entry.skillId" /></span>
  </label>
</template>
