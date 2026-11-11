import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { API_GROUPS, EVENT_CHANNELS, type MintApi } from '@shared/api'

/**
 * The only bridge between the sandboxed renderer and the main process:
 * a fixed set of invoke channels and event subscriptions.
 */
const api: Record<string, unknown> = {}
for (const [group, methods] of Object.entries(API_GROUPS)) {
  const g: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods) g[method] = (...args: unknown[]) => ipcRenderer.invoke(`${group}:${method}`, ...args)
  api[group] = g
}

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

api.on = {
  stream: subscribe(EVENT_CHANNELS.stream),
  progress: subscribe(EVENT_CHANNELS.progress),
  classChanged: subscribe(EVENT_CHANNELS.classChanged),
  update: subscribe(EVENT_CHANNELS.update),
  popouts: subscribe(EVENT_CHANNELS.popouts),
  message: subscribe(EVENT_CHANNELS.message)
} satisfies MintApi['on']

contextBridge.exposeInMainWorld('mint', api as unknown as MintApi)

/** Drag-and-drop support: the absolute path of a dropped file or folder ('' when unavailable). */
contextBridge.exposeInMainWorld('mintHost', {
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
})
