import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Annotation,
  ClassMeta,
  Curriculum,
  CurriculumProposal,
  Diagnostic,
  Explorable,
  GlossaryTerm,
  HelpEvent,
  LearningRecord,
  NoteDoc,
  Session,
  SourceDoc,
  SourceMeta,
  SourceProposal,
  Thread,
  TopicProgress
} from '@shared/types'
import { KeyedMutex, readJson, removePath, writeFileAtomic, writeJson } from './fsutil'
import { toAgentMarkdown } from '../sources'

/** Every JSON state file a class owns, keyed by file stem under `<class>/state/`. */
export interface ClassFiles {
  sources: SourceMeta[]
  proposals: SourceProposal[]
  diagnostic: Diagnostic | null
  curriculum: Curriculum | null
  curriculumProposals: CurriculumProposal[]
  progress: Record<string, TopicProgress>
  sessions: Session[]
  threads: Thread[]
  annotations: Annotation[]
  helpEvents: HelpEvent[]
  records: LearningRecord[]
  glossary: GlossaryTerm[]
  notes: NoteDoc[]
  explorables: Explorable[]
  independenceHistory: { at: string; score: number }[]
}

const DEFAULTS: { [K in keyof ClassFiles]: () => ClassFiles[K] } = {
  sources: () => [],
  proposals: () => [],
  diagnostic: () => null,
  curriculum: () => null,
  curriculumProposals: () => [],
  progress: () => ({}),
  sessions: () => [],
  threads: () => [],
  annotations: () => [],
  helpEvents: () => [],
  records: () => [],
  glossary: () => [],
  notes: () => [],
  explorables: () => [],
  independenceHistory: () => []
}

/**
 * File-backed storage for classes. Layout per class (a /teach-style workspace
 * the learner can open in Finder):
 *
 *   classes/<id>/class.json              meta (mission, intake, allowlist)
 *   classes/<id>/state/*.json            machine state (see ClassFiles)
 *   classes/<id>/sources/<sid>/doc.json  normalized source
 *   classes/<id>/sources/<sid>/content.md agent-readable text with block ids
 *   classes/<id>/sources/<sid>/original.* imported original
 *   classes/<id>/MISSION.md, CURRICULUM.md, RESOURCES.md, GLOSSARY.md,
 *   classes/<id>/learning-records/*.md, notes/*.md, reference/*.md  (exports)
 */
export class ClassRepo {
  private mutex = new KeyedMutex()

  constructor(readonly root: string) {}

  dir(classId: string): string {
    if (!/^[\w-]+$/.test(classId)) throw new Error(`Invalid class id: ${classId}`)
    return join(this.root, classId)
  }

  sourcesDir(classId: string): string {
    return join(this.dir(classId), 'sources')
  }

  /** Serialize all mutations of one class. */
  lock<T>(classId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(classId, fn)
  }

  async list(): Promise<ClassMeta[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const metas = await Promise.all(entries.map((e) => (/^[\w-]+$/.test(e) ? this.readMeta(e) : Promise.resolve(null))))
    return metas.filter((m): m is ClassMeta => m !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  readMeta(classId: string): Promise<ClassMeta | null> {
    return readJson<ClassMeta | null>(join(this.dir(classId), 'class.json'), null)
  }

  async requireMeta(classId: string): Promise<ClassMeta> {
    const meta = await this.readMeta(classId)
    if (!meta) throw new Error('mint:That class no longer exists.')
    return meta
  }

  writeMeta(meta: ClassMeta): Promise<void> {
    return writeJson(join(this.dir(meta.id), 'class.json'), meta)
  }

  read<K extends keyof ClassFiles>(classId: string, key: K): Promise<ClassFiles[K]> {
    return readJson<ClassFiles[K]>(join(this.dir(classId), 'state', `${key}.json`), DEFAULTS[key]())
  }

  write<K extends keyof ClassFiles>(classId: string, key: K, value: ClassFiles[K]): Promise<void> {
    return writeJson(join(this.dir(classId), 'state', `${key}.json`), value)
  }

  /** Read-modify-write one state file. Callers must already hold the class lock. */
  async update<K extends keyof ClassFiles>(classId: string, key: K, fn: (value: ClassFiles[K]) => ClassFiles[K] | void): Promise<ClassFiles[K]> {
    const current = await this.read(classId, key)
    const next = fn(current)
    const value = (next === undefined ? current : next) as ClassFiles[K]
    await this.write(classId, key, value)
    return value
  }

  async readSource(classId: string, sourceId: string): Promise<SourceDoc> {
    if (!/^[\w-]+$/.test(sourceId)) throw new Error('mint:Invalid source id.')
    const doc = await readJson<SourceDoc | null>(join(this.sourcesDir(classId), sourceId, 'doc.json'), null)
    if (!doc) throw new Error('mint:That source is missing. It may have been removed.')
    return doc
  }

  async writeSource(doc: SourceDoc, original?: { bytes: Uint8Array; ext: string }): Promise<SourceDoc> {
    const dir = join(this.sourcesDir(doc.classId), doc.id)
    let stored = doc
    if (original) {
      const name = `original.${original.ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`
      await writeFileAtomic(join(dir, name), original.bytes)
      stored = { ...doc, originalFile: `sources/${doc.id}/${name}` }
    }
    await writeJson(join(dir, 'doc.json'), stored)
    await writeFileAtomic(join(dir, 'content.md'), toAgentMarkdown(stored))
    return stored
  }

  removeSource(classId: string, sourceId: string): Promise<void> {
    if (!/^[\w-]+$/.test(sourceId)) throw new Error('mint:Invalid source id.')
    return removePath(join(this.sourcesDir(classId), sourceId))
  }

  removeClass(classId: string): Promise<void> {
    return removePath(this.dir(classId))
  }

  writeExport(classId: string, relPath: string, content: string): Promise<void> {
    if (relPath.includes('..')) throw new Error('Invalid export path')
    return writeFileAtomic(join(this.dir(classId), relPath), content)
  }

  removeExport(classId: string, relPath: string): Promise<void> {
    if (relPath.includes('..')) throw new Error('Invalid export path')
    return removePath(join(this.dir(classId), relPath))
  }
}
