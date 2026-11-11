import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Launched {
  app: ElectronApplication
  page: Page
  dataDir: string
  errors: string[]
  close(): Promise<void>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Launch the built app against a throwaway data folder with the offline Demo provider. */
export async function launch(opts: { pick?: string[] } = {}): Promise<Launched> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mint-e2e-'))
  // The host may run us inside another Electron app with ELECTRON_RUN_AS_NODE set.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  // MINT_E2E_EXECUTABLE runs the same flow against a packaged app (e.g. dist/mac-arm64/mint.app/Contents/MacOS/mint).
  const packaged = process.env.MINT_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [join(root, 'out/main/index.js')] }),
    env: {
      ...env,
      MINT_E2E: '1',
      MINT_DATA_DIR: join(dataDir, 'data'),
      MINT_USER_DATA: join(dataDir, 'user'),
      MINT_E2E_FIXTURES: join(root, 'tests/fixtures/e2e/fixtures.json'),
      MINT_E2E_PICK: (opts.pick ?? []).join(process.platform === 'win32' ? ';' : ':'),
      ELECTRON_RENDERER_URL: ''
    }
  })
  const errors: string[] = []
  // Every window counts: the lesson and the panel can each open one of their own.
  const watch = (p: Page): void => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`)
    })
  }
  app.on('window', watch)
  const page = await app.firstWindow()
  watch(page)
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => undefined)
  return {
    app,
    page,
    dataDir,
    errors,
    close: async () => {
      await app.close().catch(() => undefined)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

export const fixture = (name: string) => join(root, 'tests/fixtures/e2e', name)
