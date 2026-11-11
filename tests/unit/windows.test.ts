import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, Rectangle } from 'electron'
import type { PopoutKind, PopoutState, WindowMessage } from '../../src/shared/types'
import { Popouts, checkMessage, type PopoutHost } from '../../src/main/windows'

/** As much of a window as the manager touches. */
class FakeWindow {
  private handlers = new Map<string, (() => void)[]>()
  destroyed = false
  raised = 0
  constructor(public bounds: Rectangle) {}
  on(event: string, handler: () => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }
  close(): void {
    for (const h of this.handlers.get('close') ?? []) h()
    this.destroyed = true
    for (const h of this.handlers.get('closed') ?? []) h()
  }
  getBounds = (): Rectangle => this.bounds
  isDestroyed = (): boolean => this.destroyed
  isMinimized = (): boolean => false
  restore(): void {}
  show(): void {}
  focus(): void {
    this.raised += 1
  }
}

function setup(visible = true) {
  const opened: { kind: PopoutKind; at: Rectangle | null; win: FakeWindow }[] = []
  const states: PopoutState[] = []
  const relayed: WindowMessage[] = []
  const main = new FakeWindow({ x: 0, y: 0, width: 1440, height: 920 })
  const boundsFile = join(mkdtempSync(join(tmpdir(), 'mint-windows-')), 'windows.json')
  const host: PopoutHost = {
    open: (kind, size, at) => {
      const win = new FakeWindow(at ?? { x: 10, y: 10, width: size.width, height: size.height })
      opened.push({ kind, at, win })
      return win as unknown as BrowserWindow
    },
    main: () => main as unknown as BrowserWindow,
    emit: (s) => states.push(s),
    relay: (m) => relayed.push(m),
    onScreen: (b) => b.x < 3000,
    boundsFile,
    visible
  }
  return { popouts: new Popouts(host), opened, states, relayed, main, boundsFile }
}

/** Lets a fire-and-forget write (the remembered bounds) land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('windows of the lesson and the panel', () => {
  it('opens one window per part, and closing it puts the part back', async () => {
    const { popouts, opened, states } = setup()
    await popouts.detach('lesson', 'class_a')
    await popouts.detach('lesson', 'class_a') // again: the window comes forward, no second one
    expect(opened.map((o) => o.kind)).toEqual(['lesson'])
    expect(opened[0].win.raised).toBe(1)
    expect(await popouts.state()).toEqual({ lesson: 'class_a', panel: null })

    await popouts.detach('panel', 'class_a')
    expect(await popouts.state()).toEqual({ lesson: 'class_a', panel: 'class_a' })

    await popouts.attach('lesson')
    expect(opened[0].win.destroyed).toBe(true)
    expect(await popouts.state()).toEqual({ lesson: null, panel: 'class_a' })
    // The learner closed the window: the same.
    opened[1].win.close()
    expect(states.at(-1)).toEqual({ lesson: null, panel: null })
  })

  it('follows the class the main window shows, and goes when the main window goes', async () => {
    const { popouts, opened, states } = setup()
    await popouts.follow('class_b') // nothing open: nothing to tell
    expect(states).toEqual([])
    await popouts.detach('panel', 'class_a')
    await popouts.follow('class_b')
    expect(await popouts.state()).toEqual({ lesson: null, panel: 'class_b' })
    popouts.closeAll()
    expect(opened[0].win.destroyed).toBe(true)
    expect(await popouts.state()).toEqual({ lesson: null, panel: null })
  })

  it('reopens a window where it was left, unless that place is off every screen', async () => {
    const { popouts, opened, boundsFile } = setup()
    await popouts.detach('lesson', 'class_a')
    opened[0].win.bounds = { x: 300, y: 120, width: 640, height: 700 }
    await popouts.attach('lesson')
    await settle()
    expect(JSON.parse(readFileSync(boundsFile, 'utf8'))).toEqual({ lesson: { x: 300, y: 120, width: 640, height: 700 } })
    await popouts.detach('lesson', 'class_a')
    expect(opened[1].at).toEqual({ x: 300, y: 120, width: 640, height: 700 })
    await popouts.attach('lesson')
    await settle()

    writeFileSync(boundsFile, JSON.stringify({ lesson: { x: 5000, y: 0, width: 640, height: 700 }, panel: 'nonsense' }))
    await popouts.detach('lesson', 'class_a')
    await popouts.detach('panel', 'class_a')
    expect(opened[2].at).toBeNull()
    expect(opened[3].at).toBeNull()
  })

  it('brings windows forward, but never during tests that keep them hidden', async () => {
    const shown = setup()
    await shown.popouts.focus('main')
    expect(shown.main.raised).toBe(1)
    await shown.popouts.focus('panel') // not open: nothing happens
    const hidden = setup(false)
    await hidden.popouts.focus('main')
    expect(hidden.main.raised).toBe(0)
  })

  it('refuses parts and classes it does not know', async () => {
    const { popouts, opened } = setup()
    await expect(popouts.detach('sidebar' as PopoutKind, 'class_a')).rejects.toThrow(/cannot be moved/)
    await expect(popouts.detach('lesson', '../etc')).rejects.toThrow(/no longer exists/)
    expect(opened).toEqual([])
  })

  it('passes on only messages it understands, trimmed to their own fields', async () => {
    const { popouts, relayed } = setup()
    await popouts.send({ type: 'open-source', classId: 'class_a', sourceId: 'src_1', section: 'p. 2', extra: 'dropped' } as unknown as WindowMessage)
    expect(relayed).toEqual([{ type: 'open-source', classId: 'class_a', sourceId: 'src_1', section: 'p. 2', quote: undefined }])
    expect(checkMessage({ type: 'settings', classId: 'ignored' })).toEqual({ type: 'settings' })
    expect(checkMessage({ type: 'quote', classId: 'class_a', text: 'x'.repeat(9000), source: 'Book' })).toMatchObject({ text: 'x'.repeat(8000), source: 'Book' })
    expect(() => checkMessage({ type: 'command', classId: 'class_a', command: 'rm' })).toThrow(/Unknown tool/)
    expect(() => checkMessage({ type: 'navigate', classId: 'class_a' })).toThrow(/Unknown window message/)
    expect(() => checkMessage({ type: 'open-source', classId: 'class_a', sourceId: '../x' })).toThrow(/missing/)
    expect(() => checkMessage(null)).toThrow()
  })
})
