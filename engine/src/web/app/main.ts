import { createApp } from 'vue'
import App from './App.vue'
import './styles/index.css'
import { installToken } from './lib/api.js'
import { installStorage } from './lib/local.js'
import { bootLocales, startLocale } from './composables/useI18n.js'
import { connect } from './stores/session.js'

const token = new URLSearchParams(location.search).get('t') ?? ''

installStorage(localStorage)
installToken(token)
bootLocales(token)
// Awaited before mount so the first paint is already in the reader's language
// rather than a flash of English.
await startLocale()
connect({ token })

createApp(App).mount('#app')
