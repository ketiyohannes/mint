import { createContext, useContext } from 'react'
import type { Anchor, ChatCommand, ClassBundle } from '@shared/types'
import type { Directive } from '@shared/directives'

/** A diagram on screen that the tutor can point at while it explains. */
export interface DiagramController {
  highlight: (elementId: string) => void
  set: (paramId: string, value: number) => void
}

export interface StudyApi {
  bundle: ClassBundle
  classId: string
  /** The class's open lesson, while it is under way (every chat sees it). */
  sessionId: string | undefined
  sourceTitle: (sourceId: string) => string | undefined
  handleDirective: (d: Directive) => void
  /** Open a side chat (Ask popover) for an anchor near a screen rect. */
  ask: (anchor: Anchor, rect?: DOMRect, threadId?: string) => void
  /** Show a source in the panel, optionally at a section and quote. */
  openSource: (sourceId: string, section?: string, quote?: string) => void
  /** Run a chat tool (quiz, code exercise, diagram, lesson, plan) in the current chat. */
  command: (command: ChatCommand, arg?: string) => void
  /** Open a lesson over the current chat (or in the Study tab), or bring the open one into view. */
  openLesson: (sessionId: string) => void
  /** Show the Lessons tab (the plan). */
  openLessons: () => void
  /** Diagrams register so tutor directives can point at their parts. */
  registerDiagram: (explorableId: string, controller: DiagramController | null) => void
}

export const StudyCtx = createContext<StudyApi | null>(null)

export function useStudy(): StudyApi {
  const v = useContext(StudyCtx)
  if (!v) throw new Error('useStudy outside a class workspace')
  return v
}
