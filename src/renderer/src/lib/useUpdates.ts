import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { api } from './api'

export interface Updates {
  status: UpdateStatus | null
  check(): void
  /** Download and verify the available version, or open its release page when mint cannot install it here. */
  download(): void
  /** Restart into the downloaded version. */
  install(): void
  openRelease(): void
}

/** The app update state, kept live from the main process. */
export function useUpdates(): Updates {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    let live = true
    void api.updates.status().then((s) => live && setStatus(s))
    const off = api.on.update(setStatus)
    return () => {
      live = false
      off()
    }
  }, [])

  const state = status?.state
  const releaseUrl = state && 'releaseUrl' in state ? state.releaseUrl : undefined
  const openRelease = useCallback(() => {
    if (releaseUrl) void api.system.openExternal(releaseUrl)
  }, [releaseUrl])

  const check = useCallback(() => void api.updates.check().then(setStatus), [])
  const download = useCallback(() => {
    if (state?.status === 'available' && !state.installable) openRelease()
    else void api.updates.download().then(setStatus)
  }, [state, openRelease])
  const install = useCallback(() => void api.updates.install(), [])

  return { status, check, download, install, openRelease }
}
