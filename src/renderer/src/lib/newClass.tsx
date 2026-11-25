import { useCallback, useState, type JSX } from 'react'
import type { ClassMode } from '@shared/types'
import { useApp } from '../state/app'
import { api } from './api'
import type { IconName } from '../components/Icon'
import { LinksDialog } from '../components/LinksDialog'

/** The ways to start a class. A course can start from materials (files or links) or without any. */
export type NewClassKind = 'course' | 'links' | 'course-empty' | 'simple' | 'quick'

export const NEW_CLASS_KINDS: readonly { kind: NewClassKind; label: string; hint: string; icon: IconName }[] = [
  { kind: 'course', label: 'Course from a folder…', hint: 'A plan of lessons with checks, built on your materials.', icon: 'folderPlus' },
  { kind: 'links', label: 'Class from links…', hint: 'Videos, pages, PDFs or documents on the web.', icon: 'link' },
  { kind: 'course-empty', label: 'Course without materials', hint: 'mint finds trusted sources, then plans the lessons.', icon: 'lesson' },
  { kind: 'simple', label: 'Simple class…', hint: 'Open a paper or a book. mint lists what is in it and explains what you pick.', icon: 'list' },
  { kind: 'quick', label: 'Quick course', hint: 'Describe what you want to learn. mint writes a short course to read.', icon: 'bolt' }
]

/** The icon a class shows in lists, by how it teaches. */
export const MODE_ICON: Record<ClassMode, IconName> = { course: 'folder', simple: 'list', quick: 'bolt' }

/**
 * Start a class of one kind (asking for the materials first when the kind is
 * built on them) and open it. `dialog` is where the links are asked for: the
 * caller renders it.
 */
export function useNewClass(): { creating: boolean; create: (kind: NewClassKind) => Promise<void>; dialog: JSX.Element | null } {
  const { run, refreshClasses, go } = useApp()
  const [creating, setCreating] = useState(false)
  const [askLinks, setAskLinks] = useState(false)

  const start = useCallback(
    async (input: { paths?: string[]; urls?: string[]; mode: ClassMode }): Promise<boolean> => {
      setCreating(true)
      const meta = await run(() => api.classes.start(input))
      setCreating(false)
      if (!meta) return false
      await refreshClasses()
      go({ name: 'class', classId: meta.id, chatId: null })
      return true
    },
    [run, refreshClasses, go]
  )

  const create = useCallback(
    async (kind: NewClassKind) => {
      if (kind === 'links') return setAskLinks(true)
      const needsMaterials = kind === 'course' || kind === 'simple'
      const paths = needsMaterials ? await api.system.pickMaterials() : []
      if (needsMaterials && !paths.length) return
      await start({ paths, mode: kind === 'course-empty' ? 'course' : kind })
    },
    [start]
  )

  const dialog = askLinks ? (
    <LinksDialog
      title="New class from links"
      action={(n) => (n > 1 ? `Start with ${n} links` : 'Start the class')}
      chooseMode
      onClose={() => setAskLinks(false)}
      onSubmit={async (urls, mode) => {
        // The class opens at once; the links are read in the background.
        const ok = await start({ urls, mode })
        if (ok) setAskLinks(false)
        return ok
      }}
    />
  ) : null

  return { creating, create, dialog }
}
