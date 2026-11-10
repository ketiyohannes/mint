/**
 * Every keyboard shortcut, defined once: the handlers match against these
 * combos, and the button hints and the list in Settings are written from them,
 * so the three cannot drift apart.
 */
export const IS_MAC = /Mac/.test(navigator.userAgent)

interface Combo {
  /** The key as KeyboardEvent.key reports it. */
  key: string
  /** KeyboardEvent.code, for punctuation that moves between keyboard layouts. */
  code?: string
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean
  /** Ctrl on every platform. */
  ctrl?: boolean
  shift?: boolean
}

const COMBOS = {
  toggleSidebar: { key: 'b', mod: true },
  newChat: { key: 'n', mod: true },
  nextChat: { key: 'Tab', ctrl: true },
  previousChat: { key: 'Tab', ctrl: true, shift: true },
  togglePanel: { key: '\\', code: 'Backslash', mod: true },
  settings: { key: ',', code: 'Comma', mod: true },
  shortcuts: { key: '/', code: 'Slash', mod: true },
  foldLesson: { key: 'l', mod: true },
  runTests: { key: 'Enter', mod: true },
  checkAnswer: { key: 'Enter', mod: true },
  saveSticky: { key: 'Enter', mod: true },
  bold: { key: 'b', mod: true },
  italic: { key: 'i', mod: true },
  underline: { key: 'u', mod: true }
} as const satisfies Record<string, Combo>

export type ShortcutId = keyof typeof COMBOS

const KEY_NAMES: Record<string, string> = {
  Enter: IS_MAC ? '↵' : 'Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

/** A combo as the platform writes it: "⌘B" on macOS, "Ctrl+B" elsewhere. */
function formatCombo(c: Combo): string {
  const key = KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)
  if (IS_MAC) return `${c.ctrl ? '⌃' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`
  return [c.mod || c.ctrl ? 'Ctrl' : '', c.shift ? 'Shift' : '', key].filter(Boolean).join('+')
}

export function shortcutLabel(id: ShortcutId): string {
  return formatCombo(COMBOS[id])
}

/** ⌘ or Ctrl held with something that is not a key: "⌘ click" on macOS, "Ctrl+click" elsewhere. */
export function withMod(action: string): string {
  return IS_MAC ? `⌘ ${action}` : `Ctrl+${action}`
}

/** Whether a key press is this shortcut. Never while an IME composition is active. */
export function matchesShortcut(e: KeyboardEvent, id: ShortcutId): boolean {
  const c: Combo = COMBOS[id]
  if (e.isComposing || e.keyCode === 229 || typeof e.key !== 'string') return false
  const meta = IS_MAC && Boolean(c.mod)
  const ctrl = Boolean(c.ctrl) || (!IS_MAC && Boolean(c.mod))
  if (e.metaKey !== meta || e.ctrlKey !== ctrl || e.shiftKey !== Boolean(c.shift) || e.altKey) return false
  return e.key.toLowerCase() === c.key.toLowerCase() || (c.code !== undefined && e.code === c.code)
}

/** Whether a key press landed somewhere that takes typing (a field, an editor, an embedded page). */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|WEBVIEW)$/.test(target.tagName))
}

export interface ShortcutGroup {
  title: string
  rows: { keys: string; label: string }[]
}

/** The list shown in Settings. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    rows: [
      { keys: shortcutLabel('newChat'), label: 'New chat in the open class' },
      { keys: `${shortcutLabel('nextChat')}, ${shortcutLabel('previousChat')}`, label: 'Next or previous chat' },
      { keys: shortcutLabel('toggleSidebar'), label: 'Show or hide the sidebar' },
      { keys: shortcutLabel('togglePanel'), label: 'Show or hide the panel' },
      { keys: shortcutLabel('foldLesson'), label: 'Fold or unfold the open lesson' },
      { keys: shortcutLabel('settings'), label: 'Settings' },
      { keys: shortcutLabel('shortcuts'), label: 'This list' },
      { keys: formatCombo({ key: 'Escape' }), label: 'Leave Settings, close a menu, put a side chat away' }
    ]
  },
  {
    title: 'Chat',
    rows: [
      { keys: '/', label: 'Go to the prompt box and list the tools' },
      { keys: formatCombo({ key: 'Enter' }), label: 'Send' },
      { keys: formatCombo({ key: 'Enter', shift: true }), label: 'New line' },
      { keys: formatCombo({ key: 'ArrowUp' }), label: 'Bring back your last message (in an empty box)' },
      { keys: formatCombo({ key: 'Escape' }), label: 'Stop the reply' },
      { keys: `${formatCombo({ key: 'ArrowUp' })} ${formatCombo({ key: 'ArrowDown' })}, Tab`, label: 'Move through the tools list, pick a tool' }
    ]
  },
  {
    title: 'Questions from the tutor',
    rows: [
      { keys: '1–9', label: 'Pick an option' },
      { keys: `${formatCombo({ key: 'ArrowLeft' })} ${formatCombo({ key: 'ArrowRight' })}`, label: 'Previous or next question' },
      { keys: formatCombo({ key: 'Enter' }), label: 'Submit, on the last question' }
    ]
  },
  {
    title: 'Code exercises',
    rows: [
      { keys: shortcutLabel('runTests'), label: 'Run the tests' },
      { keys: 'Tab', label: 'Indent' }
    ]
  },
  {
    title: 'Lessons, sources and notes',
    rows: [
      { keys: shortcutLabel('checkAnswer'), label: 'Check your answer in a lesson' },
      { keys: withMod('scroll'), label: 'Zoom a PDF' },
      { keys: shortcutLabel('saveSticky'), label: 'Save a sticky note' },
      { keys: `${shortcutLabel('bold')}, ${shortcutLabel('italic')}, ${shortcutLabel('underline')}`, label: 'Bold, italic and underline in a note' },
      { keys: withMod('click'), label: 'Open a link in a note' }
    ]
  }
]
