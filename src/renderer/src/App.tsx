import type { JSX } from 'react'
import { useApp } from './state/app'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { HomeView } from './views/HomeView'
import { NewClassView } from './views/NewClassView'
import { SettingsView } from './views/SettingsView'
import { ClassView } from './views/ClassView'

export function App(): JSX.Element {
  const { route } = useApp()
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {route.name === 'home' && <HomeView />}
        {route.name === 'new-class' && <NewClassView />}
        {route.name === 'settings' && <SettingsView />}
        {route.name === 'class' && <ClassView key={route.classId} classId={route.classId} tab={route.tab} />}
      </main>
      <Toasts />
    </div>
  )
}
