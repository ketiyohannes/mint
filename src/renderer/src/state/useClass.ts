import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClassBundle, SourceDoc } from '@shared/types'
import { api, errorMessage } from '../lib/api'

/** Live snapshot of one class; refetches whenever the main process reports a change. */
export function useClassBundle(classId: string | null): { bundle: ClassBundle | null; error: string | null; reload: () => Promise<void> } {
  const [bundle, setBundle] = useState<ClassBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    if (!classId) return
    try {
      const b = await api.classes.get(classId)
      if (mine === seq.current) {
        setBundle(b)
        setError(null)
      }
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err))
    }
  }, [classId])

  useEffect(() => {
    setBundle(null)
    setError(null)
    if (!classId) return
    void reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.on.classChanged((id) => {
      if (id !== classId) return
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 40)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [classId, reload])

  return { bundle, error, reload }
}

/** Load full source documents on demand, cached per class. */
const docCache = new Map<string, SourceDoc>()

export function useSourceDoc(classId: string, sourceId: string | null, version: string | undefined): { doc: SourceDoc | null; error: string | null } {
  const [doc, setDoc] = useState<SourceDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!sourceId) {
      setDoc(null)
      return
    }
    const key = `${classId}/${sourceId}/${version ?? ''}`
    const cached = docCache.get(key)
    if (cached) {
      setDoc(cached)
      setError(null)
      return
    }
    let alive = true
    setDoc(null)
    api.sources
      .get(classId, sourceId)
      .then((d) => {
        docCache.set(key, d)
        if (alive) {
          setDoc(d)
          setError(null)
        }
      })
      .catch((err) => alive && setError(errorMessage(err)))
    return () => {
      alive = false
    }
  }, [classId, sourceId, version])
  // Never hand back the previous source's document while the new one loads.
  return { doc: doc && doc.id === sourceId ? doc : null, error }
}
