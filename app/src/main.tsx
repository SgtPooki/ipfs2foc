// Fonts are self-hosted (bundled) rather than loaded from a third-party CDN:
// the page stores session signing material, so its CSP allows no remote
// script/style/font origins.
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/800.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app.tsx'
import { loadCapabilities } from './capabilities.ts'
import LocalDashboard from './local-dashboard.tsx'
import './styles.css'

// One console, two backends: a local `ipfs2foc serve` daemon answers
// /api/capabilities and gets the control-plane view; anywhere else (the
// hosted static site) the fetch fails fast and the in-browser prepare +
// signing flow renders with hosted defaults.
const caps = await loadCapabilities()

const root = document.getElementById('root')
if (root == null) throw new Error('#root not found')
createRoot(root).render(
  <StrictMode>{caps.backend === 'local' ? <LocalDashboard caps={caps} /> : <App caps={caps} />}</StrictMode>
)
