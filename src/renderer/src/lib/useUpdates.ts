import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { api } from './api'

export interface Updates {
  status: UpdateStatus | null
  check(): void
  /** Download and verify the available version. */
  download(): void
  /** Restart into the downloaded version. */
  install(): void
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

  const check = useCallback(() => void api.updates.check().then(setStatus), [])
  const download = useCallback(() => void api.updates.download().then(setStatus), [])
  const install = useCallback(() => void api.updates.install(), [])

  return { status, check, download, install }
}
