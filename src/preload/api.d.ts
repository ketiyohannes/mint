import type { MintApi } from '../shared/api'

declare global {
  interface Window {
    mint: MintApi
  }
}

export {}
