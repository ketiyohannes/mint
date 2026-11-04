import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'
import { AppProvider } from './state/app'
import { transcribeEncoded } from './lib/voice/stt'

if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac'

// Voice test hook (local transcription only; no access to app state).
;(window as unknown as { __mintVoiceTest: unknown }).__mintVoiceTest = { transcribeEncoded }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
)
