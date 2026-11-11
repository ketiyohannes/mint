# mint

An Electron + TypeScript self-study tutor. [CONTRIBUTING.md](CONTRIBUTING.md) has the commands, profiles, environment variables and release steps; the code map is in [README.md](README.md#architecture).

## Commands

- `npm run check`: typecheck and unit tests. Run it after every change.
- `npm run test:e2e`: builds, then drives the whole app. Run it before calling interface or main-process work done. `-- --no-build` reuses the build; `-- --shots` saves a screenshot of each screen into `.shots/` to review layout.
- `npm run format`: Prettier. CI fails on unformatted code.
- Do not start `npm run dev` to check a change: it opens a window on the user's screen. The end-to-end test runs hidden.

## Rules

- The main process owns all state. The renderer reaches it only through `api` (`src/shared/api.ts`); handlers in `src/main/app.ts` validate their arguments.
- Model output that changes state needs a zod schema, a check in code, and a Demo answer (`src/main/jobs`).
- Tutor text is rendered only by `src/renderer/src/components/RichText.tsx`.
- The lesson and the panel can each be in a window of their own, running the same renderer in another view. Do not keep state they need in a module variable: use the main process or `localStorage`, and send cross-window requests as a `WindowMessage`.
- Every new control gets a `data-testid`, and a new feature extends `tests/e2e/flow.spec.ts`.
- Keyboard shortcuts are defined in `src/renderer/src/lib/shortcuts.ts`, nowhere else.
- Interface copy is short, plain and in sentence case. Comments say why, not what.
- Commit, push and release only when asked. `npm run release` cuts a release.
