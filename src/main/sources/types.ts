import type { SourceKind, SourceSection } from '@shared/types'

/**
 * Output of every importer. The store turns this into a SourceDoc by adding
 * ids, class id, origin, and timestamps.
 */
export interface ImportedSource {
  kind: SourceKind
  title: string
  url?: string
  domain?: string
  author?: string
  videoId?: string
  /** Sections with stable ids `s{i}` and blocks `s{i}b{j}` (use `normalizeSections`). */
  sections: SourceSection[]
  /** Original bytes to keep alongside the index (files and PDFs). */
  original?: { bytes: Uint8Array; ext: string }
  /** Video imported without a transcript; learner may paste one later. */
  needsTranscript?: boolean
}

export interface FetchOptions {
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}
