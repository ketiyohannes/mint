import type { BrowserWindow, Rectangle } from 'electron'
import { POPOUT_KINDS, WINDOW_MESSAGE_TYPES, type ChatCommand, type PopoutKind, type PopoutState, type WindowMessage } from '@shared/types'
import type { WindowController } from './app'
import { userError } from './services/kernel'
import { readJson, writeJson } from './store/fsutil'

export interface PopoutSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** The size each part's window opens at the first time, and the smallest it gets. */
export const POPOUT_SIZES: Record<PopoutKind, PopoutSize> = {
  lesson: { width: 560, height: 760, minWidth: 420, minHeight: 360 },
  panel: { width: 920, height: 820, minWidth: 420, minHeight: 400 }
}

/** What the window manager needs from Electron (injected, so it can be tested without it). */
export interface PopoutHost {
  /** Create a part's window, loading the app in that view. `at` is where it was last, when that is still on a screen. */
  open(kind: PopoutKind, size: PopoutSize, at: Rectangle | null): BrowserWindow
  main(): BrowserWindow | null
  emit(state: PopoutState): void
  relay(message: WindowMessage): void
  /** Whether a remembered place is still on a connected display. */
  onScreen(bounds: Rectangle): boolean
  /** The file that remembers where each window was. */
  boundsFile: string
  /** False in tests, where windows stay hidden. */
  visible: boolean
}

const CHAT_COMMANDS: readonly ChatCommand[] = ['quiz', 'code', 'diagram', 'lesson', 'plan']
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,80}$/.test(v)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

function checkKind(kind: unknown): PopoutKind {
  if (!POPOUT_KINDS.includes(kind as PopoutKind)) throw userError('That cannot be moved into a window.')
  return kind as PopoutKind
}

function checkClass(classId: unknown): string {
  if (!isId(classId)) throw userError('That class no longer exists.')
  return classId
}

/** A message as the other windows may trust it: a known type, with only that type's fields, bounded in size. */
export function checkMessage(input: unknown): WindowMessage {
  const m = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const type = WINDOW_MESSAGE_TYPES.find((t) => t === m.type)
  if (!type) throw userError('Unknown window message.')
  if (type === 'settings') return { type }
  const classId = checkClass(m.classId)
  switch (type) {
    case 'open-source':
      if (!isId(m.sourceId)) throw userError('That source is missing.')
      return { type, classId, sourceId: m.sourceId, section: text(m.section, 500), quote: text(m.quote, 2000) }
    case 'show-tab':
      return { type, classId, tab: text(m.tab, 20) ?? '' }
    case 'command':
      if (!CHAT_COMMANDS.includes(m.command as ChatCommand)) throw userError('Unknown tool.')
      return { type, classId, command: m.command as ChatCommand, arg: text(m.arg, 2000) }
    case 'quote':
      return { type, classId, text: text(m.text, 8000) ?? '', source: text(m.source, 300) ?? '' }
    case 'reveal-lesson':
      return { type, classId }
  }
}

function isBounds(v: unknown): v is Rectangle {
  const b = v as Rectangle | null
  return Boolean(b) && [b!.x, b!.y, b!.width, b!.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

/**
 * The lesson and the panel in windows of their own. Each kind has at most one
 * window; it shows whichever class the main window is on, and closing it puts
 * that part back in the main window. All windows share the main process's
 * state, so nothing is copied between them.
 */
export class Popouts implements WindowController {
  private readonly windows = new Map<PopoutKind, BrowserWindow>()
  private shown: PopoutState = { lesson: null, panel: null }
  /** Writes of the remembered places, one after another: two windows closing together must not lose each other's. */
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly host: PopoutHost) {}

  state = async (): Promise<PopoutState> => this.shown

  detach = async (kind: PopoutKind, classId: string): Promise<void> => {
    checkKind(kind)
    this.set(kind, checkClass(classId))
    const open = this.windows.get(kind)
    if (open) return this.raise(open)
    // A window that has just closed may still be writing where it was.
    await this.saving
    const saved = (await readJson<Partial<Record<PopoutKind, unknown>>>(this.host.boundsFile, {}))[kind]
    // Asked for twice in a row: the first window is the one.
    if (this.windows.has(kind) || this.shown[kind] === null) return
    const win = this.host.open(kind, POPOUT_SIZES[kind], isBounds(saved) && this.host.onScreen(saved) ? saved : null)
    this.windows.set(kind, win)
    win.on('close', () => this.remember(kind, win.getBounds()))
    win.on('closed', () => {
      if (this.windows.get(kind) === win) this.windows.delete(kind)
      this.set(kind, null)
    })
  }

  attach = async (kind: PopoutKind): Promise<void> => {
    const win = this.windows.get(checkKind(kind))
    if (win && !win.isDestroyed()) win.close()
    else this.set(kind, null)
  }

  follow = async (classId: string): Promise<void> => {
    checkClass(classId)
    for (const kind of POPOUT_KINDS) if (this.shown[kind] !== null) this.set(kind, classId)
  }

  focus = async (target: PopoutKind | 'main'): Promise<void> => {
    const win = target === 'main' ? this.host.main() : this.windows.get(checkKind(target))
    if (win && !win.isDestroyed()) this.raise(win)
  }

  send = async (message: WindowMessage): Promise<void> => this.host.relay(checkMessage(message))

  /** The main window is going: its parts have no chat to belong to. */
  closeAll(): void {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.close()
  }

  /** Resolves once every remembered place is on disk. */
  saved(): Promise<void> {
    return this.saving
  }

  /** Every open window, for whatever must reach them all (the theme of their title bars). */
  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed())
  }

  private set(kind: PopoutKind, classId: string | null): void {
    if (this.shown[kind] === classId) return
    this.shown = { ...this.shown, [kind]: classId }
    this.host.emit(this.shown)
  }

  private raise(win: BrowserWindow): void {
    if (!this.host.visible) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  private remember(kind: PopoutKind, bounds: Rectangle): void {
    this.saving = this.saving.then(async () => {
      try {
        const all = await readJson<Record<string, unknown>>(this.host.boundsFile, {})
        await writeJson(this.host.boundsFile, { ...all, [kind]: bounds })
      } catch {
        // The window opens at its default place next time.
      }
    })
  }
}
