import { createContext, useContext } from 'react'
import type { Thread } from '@shared/types'

export interface ChatApi {
  threadId: string
  /** Run a server call that streams a tutor message into this chat (shows it live). */
  stream: (task: (streamId: string) => Promise<Thread>) => Promise<void>
  busy: boolean
}

export const ChatCtx = createContext<ChatApi | null>(null)

export function useChat(): ChatApi {
  const v = useContext(ChatCtx)
  if (!v) throw new Error('useChat outside a chat')
  return v
}
