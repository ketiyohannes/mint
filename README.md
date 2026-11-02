# mint

An agent harness for self-study. Bring your own materials (or let mint build a reading list from trusted public sources), get a curriculum that adapts to you, and learn by reading the source, explaining it back, and applying it. The tutor gives less help as you need less: **the more you use mint, the less you need it.**

mint does not have its own agent loop. Every model turn runs in the **Claude Agent SDK** or the **Codex app-server**. mint owns everything around the turn: the curriculum, the session loop, the help ladder, and your records. In short: code remembers, models judge.

## Features

- **Intake → curriculum.** Mission, constraints, time, prior experience, then a short diagnostic. The tutor proposes milestones and topics, each tied to exact sections of your materials. Code validates the plan (ids, prerequisites without loops, real source sections) and you approve it, or ask for changes.
- **Trusted-source fallback.** No materials? mint searches only an allowlist of trusted domains plus YouTube, explains why each source is trustworthy, and imports a source only after you approve it. Gaps in your materials become research tasks: mint suggests sources early on, and later asks you to find them.
- **Interactive reader.** PDFs, web pages, Markdown, Word, text and YouTube (synced transcript with a player you can seek). Select text to **Ask**, **Note**, **Highlight**, **Diagram** or add a **Term**.
- **Ask popovers and stickies.** Questions open in a floating, draggable, non-modal popover beside the passage. Press Esc or minimize and the thread becomes a sticky pin in the margin. Highlight part of a reply to ask a follow-up (nesting is capped at one level). Pop any thread out to the side panel.
- **Help ladder.** Every answer is a pointer, a guiding question, a hint, or a full explanation. Each new question starts at the rung your independence level allows, and you climb with **More help**. Citations are chips that jump to the exact quote.
- **Session loop.** Brief (one win, why it matters, where to read, questions to read with) → Read → Explain → Apply → Distinguish → Wrap. Mastery requires all three checks. Mastered topics come back as spaced reviews (1, 3, 7, 14, 30 and 60 days).
- **Interactive diagrams.** The tutor writes p5.js (2D) or three.js (3D) explorables that run in a locked sandbox. Drag sliders, click any labeled part to ask about it, and watch the tutor highlight parts and move sliders while it explains.
- **Voice tutor.** Hold **Space** (or click the mic) to talk. Speech-to-text runs locally with Whisper. Replies are spoken sentence by sentence, with the diagram pointer moving in sync and captions you can ask about. Speaking an explanation also works for the explain-back checks. OpenAI voices are optional.
- **Notebook.** Your notes, stickies, an *earned* glossary (a term is added only once you can define it, and the tutor checks it against your sources), reference sheets (the tutor drafts them only while your independence is low; later you write and it reviews), and saved explorables.
- **Progress.** Independence score and trend, help-rung usage, mastery per topic, and ADR-style learning records (numbered, with evidence, superseded rather than deleted).

Every class is a plain folder you own: `MISSION.md`, `CURRICULUM.md`, `RESOURCES.md`, `GLOSSARY.md`, `learning-records/`, `notes/`, `reference/`, and `sources/<id>/content.md`, following the `/teach` workspace format.

## Run it

Requirements: macOS (Windows and Linux should work but are untested), Node 22 or newer, and at least one harness:

- **Claude**: Claude Code installed and logged in (`claude`), or an Anthropic API key entered in Settings.
- **Codex**: the `codex` CLI installed and logged in (`codex login`).
- **Demo**: offline, scripted answers for exploring the app. No model is involved.

```bash
npm install
npm run dev        # development, with hot reload
# or
npm run build && npm start
```

Pick the harness in **Settings** and press **Test connection**.

## Tests

```bash
npm run typecheck
npm test                        # unit and integration tests (headless, Demo runtime)
npm run test:e2e                # builds, then drives the real app with Playwright
MINT_VOICE=1 npx playwright test tests/e2e/voice.spec.ts    # local Whisper on real speech, plus system TTS (macOS)
MINT_LIVE=claude npx vitest run tests/unit/live-harness.test.ts   # real Claude Agent SDK (uses your account)
MINT_LIVE=codex  npx vitest run tests/unit/live-harness.test.ts   # real Codex app-server
MINT_LIVE_CODEX=1 npx vitest run tests/unit/codex.live.test.ts    # Codex protocol smoke test
```

The end-to-end test walks the whole product: intake, diagnostic, plan approval, a session to mastery, Ask, the help ladder, citations, follow-ups, stickies, notes, glossary, diagrams (including clicking a part inside the sandbox), the notebook, progress, and the trusted-source fallback. It fails on any console error.

## Architecture

```
src/main            Electron main process: owns all state
  agents/           AgentRuntime: claude.ts (Agent SDK), codex/ (app-server JSON-RPC), demo.ts
  jobs/             every prompt + zod schema + demo answer (pedagogy lives here)
  learning/         deterministic rules: curriculum validation, mastery, reviews, independence
  services/         classes, sources, intake, sessions, threads, notebook, diagrams, voice
  sources/          importers: PDF, HTML (Readability), Markdown, text, Word, YouTube
  store/            atomic JSON state, settings, keychain-encrypted secrets, /teach exports
  diagramProtocol   mint-sandbox:// scheme serving the diagram sandbox
src/preload         the only bridge: typed invoke channels + 3 event streams
src/renderer        React UI (reader, popovers, session loop, diagrams, voice)
resources/diagram-sandbox   sandboxed runtime for model-written p5/three code
```

Guardrails worth knowing:

- **Claude turns.** Built-in tools are an explicit allowlist (read and search only, plus web search and fetch only when building from trusted sources). A PreToolUse hook keeps file reads inside the class folder and web calls inside the class's trusted domains. Your own Claude Code settings, hooks and `CLAUDE.md` are not loaded.
- **Codex turns.** These run in an ephemeral read-only thread with approvals auto-declined and web search limited to `allowed_domains`.
- **Structured output.** All model output that changes state is schema-validated, then validated again by code (for example, curriculum repairs and diagram sanitizing).
- **Diagram code** runs in an opaque-origin iframe with a strict CSP and no network access.

## Known limitations

- PDFs are shown as reflowed text (page by page), not with the original layout or figures. Scanned PDFs need OCR first.
- Codex runs with your `~/.codex` configuration, so your Codex hooks and MCP servers also run on mint's turns.
- Using your personal Claude login is fine for your own use. A distributed product must use API keys, because Anthropic does not allow third-party products to offer claude.ai login.
- Local Whisper downloads its model (about 80 MB) the first time you talk. The system voice's quality depends on which voices are installed. Download a "Premium" voice in macOS System Settings → Accessibility → Spoken Content.
- This is a prototype run from source. There is no packaged installer or auto-update yet.
