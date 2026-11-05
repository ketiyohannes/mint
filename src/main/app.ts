import type { MintApi } from '@shared/api'
import { ClassRepo } from './store/classRepo'
import { SettingsStore, type SecretCipher } from './store/settingsStore'
import { Kernel, userError, userMessage, type Emitter, type KernelOptions } from './services/kernel'
import type { ModelOption, ProviderId } from '@shared/types'
import { ClassService } from './services/classes'
import { SourceService } from './services/sources'
import { IntakeService } from './services/intake'
import { SessionService } from './services/sessions'
import { ThreadService } from './services/threads'
import { NotebookService } from './services/notebook'
import { DiagramService } from './services/diagrams'
import { SetupService } from './services/setup'
import { ChatService } from './services/chat'
import { join } from 'node:path'

/** Host capabilities the core needs from Electron (injected so tests can run headless). */
export interface HostBridge {
  /** Native picker. `folders` also allows choosing directories. */
  pickFiles(opts?: { folders?: boolean }): Promise<string[]>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  platform: string
}

export type Handlers = { [G in Exclude<keyof MintApi, 'on'>]: MintApi[G] }

export interface MintCore {
  kernel: Kernel
  handlers: Handlers
  dispose(): Promise<void>
}

export function createCore(opts: { dataDir: string; cipher: SecretCipher; emitter: Emitter; host: HostBridge } & KernelOptions): MintCore {
  const repo = new ClassRepo(join(opts.dataDir, 'classes'))
  const settings = new SettingsStore(opts.dataDir, opts.cipher)
  void settings.forgetRetiredSecrets().catch(() => undefined)
  const kernel = new Kernel(repo, settings, opts.emitter, { fetchImpl: opts.fetchImpl, youtube: opts.youtube, log: opts.log })

  const classes = new ClassService(kernel)
  const sources = new SourceService(kernel)
  const intake = new IntakeService(kernel)
  const sessions = new SessionService(kernel)
  const threads = new ThreadService(kernel)
  const notebook = new NotebookService(kernel)
  const diagrams = new DiagramService(kernel)
  const setup = new SetupService(kernel, classes, sources, intake)
  const chat = new ChatService(kernel, threads, classes, sessions, setup, sources, diagrams)

  /** Models each harness offers, asked once per session (the list rarely changes). */
  const modelCache = new Map<ProviderId, ModelOption[]>()
  const handlers: Handlers = {
    settings: {
      get: () => settings.view(),
      update: async (patch) => {
        await settings.update(patch)
        return settings.view()
      },
      setSecret: async (name, value) => {
        if (name !== 'anthropic') throw userError('Unknown key.')
        await settings.setSecret(name, value)
        return settings.view()
      },
      testProvider: async (provider) => {
        if (!['claude', 'codex', 'demo'].includes(provider)) throw userError('Unknown provider.')
        const runtime = await kernel.runtime(provider)
        try {
          return await runtime.check()
        } finally {
          const s = await settings.get()
          if (s.provider !== provider) await runtime.dispose().catch(() => undefined)
        }
      },
      models: async (provider, refresh) => {
        if (!['claude', 'codex', 'demo'].includes(provider)) throw userError('Unknown provider.')
        const cached = modelCache.get(provider)
        if (cached && !refresh) return { models: cached }
        const runtime = await kernel.runtime(provider)
        try {
          const models = await runtime.listModels()
          modelCache.set(provider, models)
          return { models }
        } catch (err) {
          // Not installed or not signed in: the picker still offers the default and a custom id.
          return { models: cached ?? [], error: userMessage(err) }
        } finally {
          const s = await settings.get()
          if (s.provider !== provider) await runtime.dispose().catch(() => undefined)
        }
      },
      openDataDir: () => opts.host.openPath(opts.dataDir)
    },
    classes: {
      list: () => classes.list(),
      get: (id) => classes.get(id),
      create: (input) => classes.create(input),
      start: (input) => setup.start(input ?? {}),
      update: (id, patch) => classes.update(id, patch),
      remove: (id) => classes.remove(id),
      activate: (id) => classes.activate(id)
    },
    sources: {
      addFiles: async (classId, paths) => {
        const picked = paths && paths.length ? paths : await opts.host.pickFiles()
        if (!picked.length) return { added: [], errors: [] }
        const out = await sources.addFiles(classId, picked)
        if (out.added.length) setup.planIfUnplanned(classId)
        return out
      },
      original: (classId, id) => sources.original(classId, id),
      addUrl: async (classId, url) => {
        const out = await sources.addUrl(classId, url, 'user')
        setup.planIfUnplanned(classId)
        return out
      },
      get: (classId, id) => sources.get(classId, id),
      remove: (classId, id) => sources.remove(classId, id),
      setTranscript: (classId, id, text) => sources.setTranscript(classId, id, text),
      proposeTrusted: (classId, focus) => sources.proposeTrusted(classId, focus),
      resolveProposals: async (classId, approve, reject) => {
        await sources.resolveProposals(classId, approve ?? [], reject ?? [])
        setup.planIfUnplanned(classId)
      }
    },
    intake: {
      startDiagnostic: (id) => intake.startDiagnostic(id),
      submitDiagnostic: (id, answers) => intake.submitDiagnostic(id, answers ?? []),
      skipDiagnostic: (id) => intake.skipDiagnostic(id),
      proposeCurriculum: (id, reason) => intake.proposeCurriculum(id, reason),
      resolveCurriculum: (id, pid, accept) => intake.resolveCurriculum(id, pid, Boolean(accept)),
      autoPlan: async (id, reason) => {
        await classes.get(id) // validates the id before any background work
        await setup.plan(id, typeof reason === 'string' ? reason.slice(0, 2000) : undefined)
      }
    },
    sessions: {
      start: (classId, topicId, type) => sessions.start(classId, topicId, type === 'review' ? 'review' : 'learn'),
      setPhase: (classId, sessionId, phase) => sessions.setPhase(classId, sessionId, phase),
      submitCheck: (classId, sessionId, kind, answer) => sessions.submitCheck(classId, sessionId, kind, String(answer ?? '')),
      finish: (classId, sessionId, r, t) => sessions.finish(classId, sessionId, r ?? [], t ?? []),
      abandon: (classId, sessionId) => sessions.abandon(classId, sessionId)
    },
    chat: {
      send: (input) => chat.send(input),
      answer: (input) => chat.answer(input),
      command: (input) => chat.command(input)
    },
    threads: {
      create: (input) => threads.create(input),
      send: (input) => threads.send(input),
      moreHelp: (input) => threads.moreHelp(input),
      setPinned: (classId, threadId, pinned) => threads.setPinned(classId, threadId, Boolean(pinned)),
      remove: (classId, threadId) => threads.remove(classId, threadId),
      cancel: async (streamId) => threads.cancel(streamId)
    },
    annotations: {
      create: (classId, anchor, kind, text) => notebook.createAnnotation(classId, anchor, kind, text),
      update: (classId, id, text) => notebook.updateAnnotation(classId, id, String(text ?? '')),
      remove: (classId, id) => notebook.removeAnnotation(classId, id)
    },
    notes: {
      save: (classId, note) => notebook.saveNote(classId, note),
      remove: (classId, id) => notebook.removeNote(classId, id),
      draftReference: (classId, topicId) => notebook.draftReference(classId, topicId),
      review: (classId, id, streamId) => notebook.review(classId, id, streamId),
      fromThread: (classId, threadId) => notebook.fromThread(classId, threadId)
    },
    glossary: {
      propose: (classId, term, def, anchor) => notebook.proposeTerm(classId, String(term ?? ''), String(def ?? ''), anchor),
      update: (classId, id, patch) => notebook.updateTerm(classId, id, patch ?? {}),
      remove: (classId, id) => notebook.removeTerm(classId, id)
    },
    records: {
      supersede: (classId, id, title, body) => notebook.supersede(classId, id, String(title ?? ''), String(body ?? ''))
    },
    diagrams: {
      create: (classId, prompt, anchor) => diagrams.create(classId, String(prompt ?? ''), anchor),
      repair: (classId, id, error) => diagrams.repair(classId, id, String(error ?? '')),
      setKept: (classId, id, kept) => diagrams.setKept(classId, id, Boolean(kept)),
      remove: (classId, id) => diagrams.remove(classId, id)
    },
    system: {
      pickMaterials: () => opts.host.pickFiles({ folders: true }),
      openExternal: async (url) => {
        if (!/^https?:\/\//i.test(String(url))) throw userError('Only web links can be opened.')
        await opts.host.openExternal(url)
      },
      platform: async () => opts.host.platform
    }
  }

  return { kernel, handlers, dispose: () => kernel.dispose() }
}
