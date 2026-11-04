import { createContext, useContext } from 'react'
import type { Anchor, ChatCommand, ClassBundle } from '@shared/types'
import type { Directive } from '@shared/directives'

export interface VoiceSink {
  /** Receives a finished transcript. Return true if handled. */
  (text: string): boolean
}

/** A diagram on screen that the tutor can point at while it explains. */
export interface DiagramController {
  highlight: (elementId: string) => void
  set: (paramId: string, value: number) => void
}

export interface StudyApi {
  bundle: ClassBundle
  classId: string
  /** The open lesson's session, if the current chat is a lesson. */
  sessionId: string | undefined
  sourceTitle: (sourceId: string) => string | undefined
  handleDirective: (d: Directive) => void
  /** Open a side chat (Ask popover) for an anchor near a screen rect. */
  ask: (anchor: Anchor, rect?: DOMRect, threadId?: string) => void
  /** Show a source in the panel, optionally at a section and quote. */
  openSource: (sourceId: string, section?: string, quote?: string) => void
  /** Run a chat tool (quiz, code exercise, diagram, lesson, plan) in the current chat. */
  command: (command: ChatCommand, arg?: string) => void
  /** Speak a tutor reply if voice replies are on (or forced). */
  speakReply: (text: string, messageId: string, force?: boolean) => void
  /** Components that can take dictation register here while focused/open. */
  setVoiceSink: (owner: string, sink: VoiceSink | null) => void
  /** Diagrams register so tutor directives can point at their parts. */
  registerDiagram: (explorableId: string, controller: DiagramController | null) => void
}

export const StudyCtx = createContext<StudyApi | null>(null)

export function useStudy(): StudyApi {
  const v = useContext(StudyCtx)
  if (!v) throw new Error('useStudy outside a class workspace')
  return v
}
