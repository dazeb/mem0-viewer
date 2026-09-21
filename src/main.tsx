import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Bundled, so the app makes no third-party requests and renders offline.
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import '@fontsource/geist-mono/latin-600.css'

import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
