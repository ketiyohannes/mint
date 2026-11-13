import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // The whole product is one long flow. On the Linux and Windows CI runners each click and mouse move takes about
  // two seconds (the cause is not found yet), so the flow that takes 20 seconds locally takes over six minutes there.
  timeout: process.env.CI ? 900_000 : 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
})
