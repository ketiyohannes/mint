import { useEffect, useState } from 'react'

const isDark = () => document.documentElement.dataset.theme === 'dark'

/** Whether the app is showing its dark theme (follows Settings and the system). */
export function useDarkTheme(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}
