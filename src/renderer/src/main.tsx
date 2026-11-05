import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'
import { AppProvider } from './state/app'

if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
)
