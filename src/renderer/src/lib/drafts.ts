/**
 * Unsent text (a chat message, the code in an exercise), kept in localStorage
 * so it survives moving between chats and a restart. An empty draft is no
 * draft: its key is removed.
 */
const CHAT_PREFIX = 'mint.draft.'
const CODE_PREFIX = 'mint.code.'

/** The draft of one chat; a class's new-chat prompt has its own. */
export function chatDraftKey(classId: string, threadId: string | null | undefined): string {
  return `${CHAT_PREFIX}${classId}.${threadId ?? 'new'}`
}

/** The learner's unsent code in one exercise. */
export function codeDraftKey(messageId: string): string {
  return `${CODE_PREFIX}${messageId}`
}

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(key, text)
    else localStorage.removeItem(key)
  } catch {
    // Storage full or unavailable: the draft lives only as long as the view.
  }
}

/** A deleted class takes its chat drafts with it. */
export function clearClassDrafts(classId: string): void {
  try {
    const prefix = `${CHAT_PREFIX}${classId}.`
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key)
  } catch {
    // Nothing to clean up.
  }
}
