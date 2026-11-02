import { createContext, useContext } from 'react'
import type { Anchor, ClassBundle, Explorable } from '@shared/types'
import type { Directive } from '@shared/directives'

export interface VoiceSink {
  /** Receives a finished transcript. Return true if handled. */
  (text: string): boolean
}

export interface StudyApi {
  bundle: ClassBundle
  classId: string
  sessionId: string | undefined
  sourceTitle: (sourceId: string) => string | undefined
  handleDirective: (d: Directive) => void
  /** Open an Ask popover for an anchor near a screen rect. */
  ask: (anchor: Anchor, rect?: DOMRect, threadId?: string) => void
  /** Speak a tutor reply if voice replies are on (or forced). */
  speakReply: (text: string, messageId: string, force?: boolean) => void
  /** Components that can take dictation register here while focused/open. */
  setVoiceSink: (owner: string, sink: VoiceSink | null) => void
  openDiagram: (explorable: Explorable) => void
  activeExplorableId: string | null
}

export const StudyCtx = createContext<StudyApi | null>(null)

export function useStudy(): StudyApi {
  const v = useContext(StudyCtx)
  if (!v) throw new Error('useStudy outside StudyView')
  return v
}
