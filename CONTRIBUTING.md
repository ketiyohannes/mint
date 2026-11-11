# Working on mint

How to run, test, debug and release mint from source. The product itself is described in the [README](README.md), including a map of the code under [Architecture](README.md#architecture).

## Setup

You need Node 22 or newer (CI uses the version in `.nvmrc`).

```bash
npm install
npm run dev
```

`npm run dev` starts the app with hot reload for the interface, and restarts it when main-process or preload code changes. It works from any terminal, including the ones inside VS Code and other Electron apps.

In Settings, choose the **Demo** harness to work on the interface without a model: it answers offline with canned replies, and it is what the tests use.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run from source with hot reload. |
| `npm start` | Run the production build, unpackaged. |
| `npm run check` | Typecheck and unit tests. Takes seconds; run it before every commit. |
| `npm run test:watch` | Unit tests, re-run as files change. |
| `npm run test:e2e` | Build, then drive the whole app with Playwright. |
| `npm run verify` | `check`, then `test:e2e`. |
| `npm run format` | Format the code with Prettier. `npm run format:check` only reports, and CI runs it. |
| `npm run dist` | Package for this system into `dist/` (`npm run dist:mac` for the Apple silicon disk image). |
| `npm run release` | Cut a release (see [Releasing](#releasing)). |
| `npm run icon` | Redraw the app icon (Python 3 with Pillow). |

Flags go after `--`:

```bash
npm run dev -- --fresh       # a new, empty profile for this run: the first-run experience
npm run dev -- --real        # the installed app's profile and data (quit mint first)
npm run dev -- --inspect     # let a debugger attach to the main process on port 5858

npm run test:e2e -- --no-build          # reuse the last build
npm run test:e2e -- --show              # watch the window while the test drives it
npm run test:e2e -- --shots             # save a screenshot of each screen into .shots/
npm run test:e2e -- --app dist/mac-arm64/mint.app/Contents/MacOS/mint   # drive a packaged app
npm run test:e2e -- --debug             # any other flag goes to Playwright
```

## Profiles and data

A copy of mint run from source keeps its own profile, `mint-dev`, next to the installed app's `mint` profile in the system's application data folder (on macOS, `~/Library/Application Support`). Your real classes are never touched by a development build, and the two can run at the same time.

- `--fresh` gives one run a throwaway profile, removed when mint quits.
- `--real` uses the installed app's profile. Quit the installed app first: only one mint may use a profile at a time, and a second one hands over to the first and exits.

Settings → Data folder opens the folder of the profile in use.

## Tests

- **Unit tests** (`tests/unit`, Vitest) cover the main process and the shared logic: importers, the curriculum and mastery rules, the services, the Codex protocol, the updater's pure parts. They run headless against the Demo runtime, with no Electron.
- **The end-to-end test** (`tests/e2e/flow.spec.ts`, Playwright) is one long flow through the whole product. It fails on any console error. It finds controls by `data-testid`, so give every new control one and extend the flow when you add a feature.
- **Live tests** call a real model and are skipped unless asked for:

  ```bash
  MINT_LIVE=claude npx vitest run tests/unit/live-harness.test.ts   # Claude Agent SDK, on your account
  MINT_LIVE=codex  npx vitest run tests/unit/live-harness.test.ts   # Codex app-server
  MINT_LIVE_CODEX=1 npx vitest run tests/unit/codex.live.test.ts
  ```

CI (`.github/workflows/ci.yml`) runs `npm run format:check`, `npm run check` and the end-to-end test on every push to `main` and every pull request.

## Environment variables

| Variable | Effect |
| --- | --- |
| `MINT_USER_DATA` | Folder for the profile (settings, window state, the single-instance lock). |
| `MINT_DATA_DIR` | Folder for classes and settings. Default: `data/` inside the profile. |
| `MINT_DEV_PROFILE=0` | From source, use the installed app's profile instead of `mint-dev` (`npm run dev -- --real`). |
| `MINT_E2E=1` | Test mode: no keychain, no single-instance lock, no update checks, a hidden window. |
| `MINT_E2E_SHOW=1` | Show the window in test mode (`--show`). |
| `MINT_E2E_EXECUTABLE` | A packaged app for the end-to-end test to drive (`--app`). |
| `MINT_E2E_FIXTURES` | A JSON map from URL to file that replaces the network in test mode. |
| `MINT_E2E_PICK` | The paths the "add materials" dialog returns in test mode. |
| `MINT_SHOTS` | Folder for the end-to-end test's screenshots (`--shots`). |
| `MINT_UPDATE_FEED` | A URL to read updates from instead of GitHub, for testing the updater against local builds. |
| `MINT_UPDATE_APPLICATIONS` | With `MINT_UPDATE_FEED`: the folder the macOS updater installs into instead of `/Applications`. |

## Making changes

**State lives in the main process.** The renderer asks for everything through one typed API and never touches the disk or the network. To add a call:

1. Declare it in `MintApi` and add its name to `API_GROUPS` in `src/shared/api.ts`. The compiler rejects a method that is in one and not the other.
2. Implement the handler in `src/main/app.ts`. Validate its arguments there: they arrive from the renderer unchecked.
3. Call it in the renderer as `api.<group>.<method>()`. The preload bridge is generated from `API_GROUPS`, so there is nothing to write in `src/preload`.

Errors a learner should read are thrown with a message starting `mint:`; anything else reaches the interface as "Something went wrong".

**More than one window.** The lesson and the panel can each be moved into a window of their own (`src/main/windows.ts`). Such a window runs the same renderer with `?view=lesson` or `?view=panel`, and `Workspace` renders only that part. Windows share nothing in memory: they all read the main process's state, and what one asks of another (open this source, run this tool in the chat) is a `WindowMessage` sent with `api.windows.send`, which every window receives and acts on only for the part it shows. State a part needs in whichever window it is in belongs in the main process or in `localStorage`, not in a module variable.

**Model output is never trusted.** Each job in `src/main/jobs` has a zod schema and a Demo answer; whatever changes state is validated by the schema and then checked again by code. A new job needs all three: the prompt, the schema, and the Demo answer.

**Tutor text has one renderer**, `src/renderer/src/components/RichText.tsx`, which sanitizes it. Do not render model text any other way.

**Style.** Prettier formats the TypeScript, the scripts and the stylesheet (`.prettierrc.json`); run `npm run format` before you commit, because CI checks it. TypeScript is strict and rejects unused locals and parameters. Comments say why, not what. Interface copy is short, plain and in sentence case.

**Keyboard shortcuts** are defined once, in `src/renderer/src/lib/shortcuts.ts`. Handlers match against that table, and the button hints and the list in Settings are written from it, so add a shortcut there first.

## Debugging

- **Interface:** F12 opens the developer tools in a copy run from source (on macOS, View → Toggle Developer Tools works too).
- **Main process:** `npm run dev -- --inspect`, then attach a debugger to port 5858 (in Chrome, `chrome://inspect`). Its `console.log` output is in the terminal, prefixed `[mint]`.
- **A failed end-to-end run** leaves a trace in `test-results/`: `npx playwright show-trace test-results/<folder>/trace.zip` replays it step by step with DOM snapshots.
- **The updater** can be tested without publishing: build two versions, serve the newer one's `dist/` folder over HTTP, and start the older one with `MINT_UPDATE_FEED` pointing at it.

## Releasing

```bash
npm run release                      # the next pre-release: 0.1.0-alpha.12 -> 0.1.0-alpha.13
npm run release -- 0.2.0             # an explicit version
npm run release -- --notes "…"       # release notes (default: generated from the commits)
npm run release -- --dry-run         # print the plan and change nothing
npm run release -- --gh-user <name>  # act as this GitHub CLI account when several are logged in
```

It needs a clean `main` and the [GitHub CLI](https://cli.github.com). It writes the version into `package.json`, `package-lock.json` and the release workflow's comments, runs `npm run check`, commits, pushes, and creates the release. The tag starts `.github/workflows/release.yml`, which builds macOS, Windows and Linux on their own runners, runs the end-to-end test against each packaged app, and uploads the installers and the update feeds (`latest*.yml`). That takes about ten minutes; installed copies then offer the update on their next check.
