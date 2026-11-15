import { useCallback, useState } from 'react'
import type { ClassMode } from '@shared/types'
import { useApp } from '../state/app'
import { api } from './api'
import type { IconName } from '../components/Icon'

/** The ways to start a class. A course can start from materials or without any. */
export type NewClassKind = 'course' | 'course-empty' | 'simple' | 'quick'

export const NEW_CLASS_KINDS: readonly { kind: NewClassKind; label: string; hint: string; icon: IconName }[] = [
  { kind: 'course', label: 'Course from a folder…', hint: 'A plan of lessons with checks, built on your materials.', icon: 'folderPlus' },
  { kind: 'course-empty', label: 'Course without materials', hint: 'mint finds trusted sources, then plans the lessons.', icon: 'lesson' },
  { kind: 'simple', label: 'Simple class…', hint: 'Open a paper or a book. mint lists what is in it and explains what you pick.', icon: 'list' },
  { kind: 'quick', label: 'Quick course', hint: 'Describe what you want to learn. mint writes a short course to read.', icon: 'bolt' }
]

/** The icon a class shows in lists, by how it teaches. */
export const MODE_ICON: Record<ClassMode, IconName> = { course: 'folder', simple: 'list', quick: 'bolt' }

/** Start a class of one kind (asking for the materials first when the kind is built on them) and open it. */
export function useNewClass(): { creating: boolean; create: (kind: NewClassKind) => Promise<void> } {
  const { run, refreshClasses, go } = useApp()
  const [creating, setCreating] = useState(false)
  const create = useCallback(
    async (kind: NewClassKind) => {
      const needsMaterials = kind === 'course' || kind === 'simple'
      const paths = needsMaterials ? await api.system.pickMaterials() : []
      if (needsMaterials && !paths.length) return
      setCreating(true)
      const meta = await run(() => api.classes.start({ paths, mode: kind === 'course-empty' ? 'course' : kind }))
      setCreating(false)
      if (!meta) return
      await refreshClasses()
      go({ name: 'class', classId: meta.id, chatId: null })
    },
    [run, refreshClasses, go]
  )
  return { creating, create }
}
