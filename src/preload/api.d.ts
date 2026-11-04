import type { MintApi } from '../shared/api'

declare global {
  interface Window {
    mint: MintApi
    mintHost: { pathForFile(file: File): string }
  }
}

export {}
