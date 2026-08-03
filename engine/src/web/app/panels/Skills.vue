<script setup lang="ts">
/**
 * The component map, the machine's skill library, and what this project has
 * accepted of it. `panels/skills.js`, ported.
 *
 * Read-only, and permanently so. Accepting a map or activating a skill changes
 * what every later run is told to use, which is the class of write
 * `web/writes.ts` denies the browser — the same list `runStart` and
 * `cycleAdvance` are on. So this panel reports and offers nothing to press,
 * beyond the search form: querying a source and drawing candidates back is
 * not a write. `mjloop-cli profile accept` and `mjloop-cli skills
 * accept|disable|enable|remove` are where those decisions are made, and a
 * line under each block says so.
 *
 * The map rides `revisions.profile` (`/api/profile`); the library, this
 * project's acceptances, and what this checkout's own `.claude/skills/`
 * holds all ride `revisions.skills` (`/api/skills`) — one document, so the
 * join between an acceptance and the library package it names, and the join
 * between an acceptance and the on-disk skill it routes, can both be made
 * client-side. See `lib/skills.ts`'s `joinAcceptances`.
 *
 * Search is the one live round trip this panel makes outside those two feeds
 * — through `lib/api.ts`'s `get`, never the socket, and held in
 * `useSkillSearch()` rather than a feed: a search is a question asked once,
 * not a document that follows a revision.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { useSkillSearch } from '../composables/useSkillSearch.js'
import { joinAcceptances } from '../lib/skills.js'
import { stamp } from '../lib/fmt.js'
import type { ProfileView, SkillsView } from '../types/protocol.js'
import Tx from '../components/Tx.vue'
import SkillProfileComponentRow from '../components/SkillProfileComponentRow.vue'
import ProjectSkillRow from '../components/ProjectSkillRow.vue'
import ProjectSkillUnreadableRow from '../components/ProjectSkillUnreadableRow.vue'
import SkillCandidateRow from '../components/SkillCandidateRow.vue'
import SkillAcceptanceRow from '../components/SkillAcceptanceRow.vue'
import SkillPackageRow from '../components/SkillPackageRow.vue'
import SkillUnreadableRow from '../components/SkillUnreadableRow.vue'

const { t } = useI18n()

const profileFeed = useFeed<ProfileView>({
  dep: (state) => state.revisions.profile,
  path: () => '/api/profile',
})
const profile = computed(() => profileFeed.value.value)
// A 404 *is* an answer here — it is what a project nothing has ever mapped
// returns — and it arrives as a failure rather than as a body, so "settled"
// has to consider both.
const profileAnswered = computed(() => profile.value !== null || profileFeed.error.value !== null)
// Only once an accepted map is on screen for it to disagree with. Before
// that the empty line already says nothing is accepted, and two sentences
// about one absence is one too many.
const profileDrift = computed(() => profile.value !== null && profile.value.revision !== null && profile.value.proposalDiffers)

const skillsFeed = useFeed<SkillsView>({
  dep: (state) => state.revisions.skills,
  path: () => '/api/skills',
})
const skills = computed(() => skillsFeed.value.value)
const joined = computed(() => joinAcceptances(skills.value))
const onDisk = computed(() => skills.value?.onDisk ?? [])
const packages = computed(() => skills.value?.packages ?? [])

const { candidates, code: searchCode, asked: searchAsked, search } = useSkillSearch()

const query = ref('')
const source = ref('github')

async function onSubmit(): Promise<void> {
  await search(query.value, source.value)
}
</script>

<template>
  <section id="panel-skills" class="panel" aria-labelledby="panel-skills-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-skills-title">{{ t('panel.skills.title') }}</h1>
        <p class="hint">{{ t('panel.skills.help') }}</p>
      </div>
    </header>

    <section class="block" id="skills-profile-block">
      <h2>{{ t('config.profile') }}</h2>
      <p class="hint">{{ t('config.profileWhy') }}</p>
      <p class="record" id="skills-profile-record" :hidden="profile === null || profile.revision === null">
        <template v-if="profile !== null && profile.revision !== null">
          <Tx
            key-name="config.profileRecord"
            :params="{ revision: profile.revision, by: profile.acceptedBy ?? '', at: profile.acceptedAt === null ? '' : stamp(profile.acceptedAt) }"
          />
        </template>
      </p>
      <p class="banner warn" id="skills-profile-drift" :hidden="!profileDrift">
        <template v-if="profile !== null && profileDrift">
          <Tx key-name="config.profileDrift" :params="{ at: profile.proposedAt === null ? '' : stamp(profile.proposedAt) }" />
        </template>
      </p>
      <p class="empty" id="skills-profile-empty" :hidden="(profile !== null && profile.revision !== null) || !profileAnswered">
        {{ t('config.profileNone') }}
      </p>
      <div id="skills-profile-list">
        <SkillProfileComponentRow v-for="component in profile?.components ?? []" :key="component.id" :component="component" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('skills.onDisk') }}</h2>
      <p class="hint">{{ t('skills.onDiskWhy') }}</p>
      <!-- "No skills here" is claimed only once the answer is in — the
           `/api/skills` feed always settles with a body (an empty project
           and a project nothing was ever asked about both answer with empty
           arrays), so `skills !== null` is the settled check. -->
      <p class="empty" id="skills-ondisk-empty" :hidden="skills === null || onDisk.length > 0">{{ t('skills.onDiskNone') }}</p>
      <div id="skills-ondisk">
        <ProjectSkillRow v-for="skill in onDisk" :key="skill.path" :skill="skill" />
      </div>
      <div id="skills-ondisk-unreadable">
        <ProjectSkillUnreadableRow v-for="entry in skills?.onDiskUnreadable ?? []" :key="entry.path" :entry="entry" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('skills.search') }}</h2>
      <p class="hint">{{ t('skills.searchWhy') }}</p>
      <form id="skills-search" @submit.prevent="onSubmit">
        <label>
          <span>{{ t('skills.searchQuery') }}</span>
          <input id="skills-search-q" name="q" type="search" autocomplete="off" :aria-label="t('skills.searchQuery')" v-model="query" />
        </label>
        <label>
          <span>{{ t('skills.searchSource') }}</span>
          <select id="skills-search-source" name="source" :aria-label="t('skills.searchSource')" v-model="source">
            <option value="github">github</option>
            <option value="skills-sh">skills.sh</option>
            <option value="registry">registry</option>
            <option value="web">web</option>
          </select>
        </label>
        <button type="submit">{{ t('skills.searchGo') }}</button>
      </form>
      <p class="banner warn" id="skills-search-error" :hidden="searchCode === null">
        {{ searchCode === null ? '' : t(searchCode) }}
      </p>
      <p class="empty" id="skills-search-empty" :hidden="!searchAsked || searchCode !== null || candidates.length > 0">
        {{ t('skills.searchNone') }}
      </p>
      <div id="skills-search-results">
        <SkillCandidateRow v-for="candidate in candidates" :key="candidate.url" :candidate="candidate" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('skills.acceptances') }}</h2>
      <p class="hint">{{ t('skills.acceptancesWhy') }}</p>
      <p class="empty" id="skills-acceptances-empty" :hidden="skills === null || joined.length > 0">{{ t('skills.acceptancesNone') }}</p>
      <div id="skills-acceptances">
        <SkillAcceptanceRow v-for="entry in joined" :key="entry.acceptance.skillId" :entry="entry" />
      </div>
    </section>

    <section class="block">
      <h2>{{ t('skills.library') }}</h2>
      <p class="hint">{{ t('skills.libraryWhy') }}</p>
      <p class="empty" id="skills-library-empty" :hidden="skills === null || packages.length > 0">{{ t('skills.libraryNone') }}</p>
      <div id="skills-library">
        <SkillPackageRow v-for="pkg in packages" :key="pkg.digest" :pkg="pkg" />
      </div>
      <div id="skills-unreadable">
        <SkillUnreadableRow v-for="entry in skills?.unreadable ?? []" :key="entry.digest" :entry="entry" />
      </div>
    </section>
  </section>
</template>
