import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'
import { Popout } from './Popout'
import { WINDOW_VIEW } from './lib/windows'
import { AppProvider, THEME_KEY } from './state/app'

if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac'
// Windows draws its window buttons over the app's top-right corner.
else if (/Windows/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'win'

// Paint the theme the app last showed; Settings confirm it once they load.
try {
  document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
} catch {
  document.documentElement.dataset.theme = 'light'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>{WINDOW_VIEW === 'main' ? <App /> : <Popout view={WINDOW_VIEW} />}</AppProvider>
  </StrictMode>
)
