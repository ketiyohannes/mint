import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, launch, type Launched } from './harness'

/** Select `text` inside the first element matching `scope` and fire mouseup, like a learner would. */
async function selectText(page: Page, scope: string, text: string): Promise<void> {
  const ok = await page.evaluate(
    ({ scope, text }) => {
      const roots = Array.from(document.querySelectorAll(scope))
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const idx = n.textContent?.indexOf(text) ?? -1
          if (idx < 0) continue
          const range = document.createRange()
          range.setStart(n, idx)
          range.setEnd(n, idx + text.length)
          const sel = window.getSelection()!
          sel.removeAllRanges()
          sel.addRange(range)
          ;(n.parentElement ?? root).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          return true
        }
      }
      return false
    },
    { scope, text }
  )
  expect(ok, `text "${text}" should exist in ${scope}`).toBe(true)
}

let m: Launched

/** Set MINT_SHOTS=<dir> to save a screenshot of each screen for visual review. */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.MINT_SHOTS) await page.screenshot({ path: `${process.env.MINT_SHOTS}/${name}.png` })
}

test.afterEach(async () => {
  await m?.close()
})

/** Size of a named CSS highlight (the PDF page view paints marks with the CSS Highlight API). */
/** The app shell must never scroll: only the panes do. */
async function expectShellInPlace(page: Page): Promise<void> {
  const tops = await page.evaluate(() => ['.app', '.chat-pane .pane-head', '.side-panel .pane-head', '.sidebar'].map((sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? -1)))
  if (tops.some((t) => t !== 0)) {
    const scrolled = await page.evaluate(() =>
      [document.documentElement, document.body, ...Array.from(document.querySelectorAll('*'))]
        .filter((el) => el.scrollTop || el.scrollLeft)
        .map((el) => `${el.tagName}.${(el as HTMLElement).className} ${el.scrollTop},${el.scrollLeft}`)
        .slice(0, 12)
    )
    console.log('SHELL MOVED', tops, scrolled)
  }
  expect(tops).toEqual([0, 0, 0, 0])
}

async function highlightCount(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(n)?.size ?? 0, name)
}

/** A folder of materials, like a project folder. */
function materialsFolder(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'mint-folder-')), 'Linear Algebra')
  mkdirSync(dir)
  copyFileSync(fixture('eigen.pdf'), join(dir, 'eigen.pdf'))
  copyFileSync(fixture('eigen.md'), join(dir, 'notes.md'))
  return dir
}

/** Type into the composer and send. */
async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('ask-input').last().fill(text)
  await page.getByTestId('ask-send').last().click()
}

test('a learner opens a folder, talks to the tutor, and learns with lessons, quizzes, code, diagrams and the reader', async () => {
  m = await launch({ pick: [materialsFolder()] })
  const { page } = m
  page.on('dialog', (d) => void d.accept())

  // --- Settings: offline Demo harness ---------------------------------------------
  await expect(page.getByTestId('welcome-open-folder')).toBeVisible()
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('provider-demo').click()
  await page.getByTestId('test-provider').click()
  await expect(page.getByTestId('test-result')).toContainText('Demo mode')
  // Updates: the version shows; tests never reach out to GitHub.
  await expect(page.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+/)
  await expect(page.getByTestId('update-status')).toContainText('off during tests')
  await expect(page.getByTestId('update-row')).toHaveCount(0)

  // --- Open a folder: a class, with the prompt in the middle ---------------------------
  await page.getByTestId('open-folder').click()
  await expect(page.getByTestId('sidebar-class')).toContainText('Linear Algebra')
  await expect(page.getByTestId('chat-hero')).toContainText('What do you want to learn?')
  await expect(page.getByTestId('source-tab')).toHaveCount(2, { timeout: 20_000 })
  await expect(page.getByTestId('composer')).toBeVisible()
  // The model picker lives in the prompt box (Demo has no models to choose).
  await expect(page.getByTestId('model-picker')).toContainText('Demo')
  await page.getByTestId('model-picker').click()
  await expect(page.getByTestId('model-menu')).toContainText('Demo mode is scripted and has no models.')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('model-menu')).toHaveCount(0)
  await shot(page, 'new-class')

  // --- Intake as questions in the chat (like a coding agent asking before it plans) ------
  await say(page, 'I want to understand eigenvectors well enough for machine learning')
  const questions = page.getByTestId('questions')
  await expect(questions).toBeVisible()
  await expect(page.getByTestId('sidebar-chat')).toHaveCount(1)
  await shot(page, 'intake-questions')
  await questions.press('1') // number keys pick, like a terminal prompt
  await expect(questions.locator('.qw-tab.on')).toContainText('Background')
  await page.getByTestId('question-option').nth(1).click()
  await expect(questions.locator('.qw-tab.on')).toContainText('Style')
  await page.getByTestId('question-option').nth(1).click()
  await page.getByTestId('question-other').fill('Short sessions on my commute')
  await page.getByTestId('questions-submit').click()
  await expect(page.getByTestId('questions-done')).toContainText('Short sessions on my commute')
  await expect(page.getByTestId('plan-widget')).toBeVisible({ timeout: 20_000 })
  await shot(page, 'plan')

  // --- Chat with the tutor: help ladder, follow-up side chat ------------------------------
  await say(page, 'Why does an eigenvector keep its direction?')
  await expect(page.getByTestId('tutor-message').last()).toContainText(/Hint|look|passage/i)
  await page.getByTestId('more-help').click()
  await expect(page.getByTestId('tutor-message').last()).toContainText('full explanation', { timeout: 15_000 })
  await selectText(page, '[data-testid=chat-body] [data-testid=tutor-message]', 'full explanation')
  await page.getByTestId('ask-followup').click()
  const side = page.getByTestId('ask-popover')
  await expect(side).toContainText('Follow-up on a reply')
  await side.getByTestId('ask-input').fill('What does that mean?')
  await side.getByTestId('ask-send').click()
  await expect(side.getByTestId('tutor-message').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(side).toHaveCount(0)

  // --- Tools from the composer: slash commands and the actions menu ---------------------
  await page.getByTestId('ask-input').last().fill('/qu')
  await expect(page.getByTestId('slash-menu')).toContainText('/quiz')
  await page.getByTestId('ask-input').last().press('Enter') // completes "/quiz "
  await expect(page.getByTestId('ask-input').last()).toHaveValue('/quiz ')
  await page.getByTestId('ask-input').last().press('Enter')
  const quiz = page.getByTestId('quiz').last()
  await expect(quiz).toBeVisible()
  const options = quiz.getByTestId('quiz-option')
  await options.nth(1).click()
  await options.nth(6).click()
  await options.nth(8).click()
  await quiz.getByTestId('quiz-submit').click()
  await expect(quiz.getByTestId('quiz-score')).toHaveText('3/3')
  await expect(quiz.locator('.katex').first()).toBeVisible() // LaTeX in options

  await page.getByTestId('composer-actions').last().click()
  await page.getByTestId('action-code').click()
  const code = page.getByTestId('code-widget').last()
  await expect(code).toBeVisible()
  await code.getByTestId('code-run').click()
  await expect(code.getByTestId('code-output')).toContainText('1/3 tests passing', { timeout: 20_000 })
  await code.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+A')
  // insertText, like a paste: the editor auto-closes brackets while typing.
  await page.keyboard.insertText('function scale(v, k) {\n  return v.map((x) => x * k)\n}\n')
  await code.getByTestId('code-run').click()
  await expect(code.getByTestId('code-output')).toContainText('3/3 tests passing')
  await code.getByTestId('code-submit').click()
  await expect(page.getByTestId('tutor-message').last()).toContainText('All 3 tests pass', { timeout: 15_000 })
  await shot(page, 'code')

  await say(page, '/diagram how a matrix stretches a vector')
  const diagram = page.getByTestId('diagram-widget').last()
  await expect(diagram).toBeVisible()
  await expect(diagram.frameLocator('iframe').locator('canvas').first()).toBeVisible({ timeout: 20_000 })
  await diagram.getByRole('button', { name: 'Origin' }).click()
  await expect(page.getByTestId('ask-popover')).toContainText('Diagram')
  await page.getByTestId('ask-popover').getByTestId('ask-input').fill('What is this point?')
  await page.getByTestId('ask-popover').getByTestId('ask-send').click()
  await expect(page.getByTestId('ask-popover').getByTestId('tutor-message').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await shot(page, 'diagram')
  await expectShellInPlace(page)

  // --- Reader: the original PDF in the Sources tab ----------------------------------------
  await page.getByTestId('source-tab').filter({ hasText: 'Eigenvectors' }).first().click()
  if (!(await page.getByTestId('pdf-view').count())) await page.getByTestId('source-tab').nth(1).click()
  await expect(page.getByTestId('pdf-view')).toBeVisible()
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeAttached({ timeout: 20_000 })
  // Dark pages: the paper inverts, the selectable text layer and highlights do not.
  await page.getByTestId('pdf-dark').click()
  await expect(page.getByTestId('pdf-view')).toHaveClass(/dark/)
  await expect(page.locator('.pdf-page canvas').first()).toHaveCSS('filter', /invert/)
  await shot(page, 'pdf-dark')
  await page.getByTestId('pdf-dark').click()
  await expect(page.getByTestId('pdf-view')).not.toHaveClass(/dark/)
  // Zoom: buttons step it, the level resets to fit width, and Ctrl + scroll (a trackpad pinch) zooms the pages.
  const pageWidth = async () => (await page.locator('.pdf-page[data-page="1"]').boundingBox())!.width
  const fit = await pageWidth()
  await page.getByTestId('pdf-zoom-in').click()
  await expect(page.getByTestId('pdf-zoom-level')).toHaveText('125%')
  await expect.poll(pageWidth).toBeCloseTo(fit * 1.25, -1)
  await page.getByTestId('pdf-zoom-in').click()
  await expect(page.getByTestId('pdf-zoom-level')).toHaveText('150%')
  const scroller = page.getByTestId('pdf-view')
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true) // wider than the column: scrolls sideways
  await shot(page, 'pdf-zoom')
  await page.getByTestId('pdf-zoom-level').click()
  await expect(page.getByTestId('pdf-zoom-level')).toHaveText('100%')
  await page.getByTestId('pdf-zoom-out').click()
  await expect(page.getByTestId('pdf-zoom-level')).toHaveText('80%')
  await expect.poll(pageWidth).toBeCloseTo(fit * 0.8, -1)
  const view = (await scroller.boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -40)
  await page.keyboard.up('Control')
  await expect.poll(async () => Number((await page.getByTestId('pdf-zoom-level').innerText()).replace('%', ''))).toBeGreaterThan(80)
  await page.getByTestId('pdf-zoom-level').click()
  await expect.poll(pageWidth).toBeCloseTo(fit, -1)
  await expect(page.locator('.pdf-page[data-page="1"] .textLayer span').first()).toBeAttached()
  await selectText(page, '[data-testid=pdf-view] .textLayer', 'a typical vector ends up pointing somewhere new')
  await page.getByTestId('sel-ask').click()
  const pop = page.getByTestId('ask-popover')
  await pop.getByTestId('ask-input').fill('Why do most vectors change direction?')
  await pop.getByTestId('ask-send').click()
  await expect(pop.locator('.cite-chip').first()).toBeVisible()
  await expect.poll(() => highlightCount(page, 'mint-thread')).toBeGreaterThan(0)
  const rungBefore = await pop.getByTestId('rung-bar').innerText()
  await pop.getByTestId('more-help').click()
  await expect(pop.getByTestId('tutor-message')).toHaveCount(2)
  await expect(pop.getByTestId('rung-bar')).not.toHaveText(rungBefore)
  await pop.locator('.cite-chip').first().click()
  await expect
    .poll(async () => (await highlightCount(page, 'mint-flash')) + (await page.locator('.block.flash, mark.hl.flash-quote').count()))
    .toBeGreaterThan(0)
  await page.getByTestId('popover-minimize').click()
  await expect(page.getByTestId('pin-thread').first()).toBeVisible()
  await selectText(page, '[data-testid=pdf-view] .textLayer', 'The whole idea fits in one equation')
  await page.getByTestId('sel-highlight').click()
  await expect.poll(() => highlightCount(page, 'mint-hl')).toBeGreaterThan(0)
  await selectText(page, '[data-testid=pdf-view] .textLayer', 'These special vectors are called eigenvectors')
  await page.getByTestId('sel-note').click()
  await page.getByTestId('note-input').fill('Eigenvectors: directions the matrix only stretches.')
  await page.getByTestId('note-save').click()
  await expect(page.getByTestId('pin-note').first()).toBeVisible()
  await shot(page, 'reader')

  // Chat about a highlighted passage in the main chat, not only in a side chat.
  await selectText(page, '[data-testid=pdf-view] .textLayer', 'they stay on the')
  await page.getByTestId('sel-chat').click()
  await expect(page.getByTestId('composer-quote')).toContainText('they stay on the')
  await expect(page.getByTestId('composer-quote')).toContainText('Eigenvectors')
  await shot(page, 'quote')
  const tutorReplies = await page.getByTestId('tutor-message').count()
  await say(page, 'What does staying on the line mean here?')
  const quoted = page.getByTestId('user-message').last()
  await expect(quoted.locator('.user-quote')).toContainText('they stay on the')
  await expect(quoted).toContainText('What does staying on the line mean here?')
  await expect(page.getByTestId('composer-quote')).toHaveCount(0)
  await expect(page.getByTestId('tutor-message')).toHaveCount(tutorReplies + 1)

  await page.getByTestId('view-text').click()
  await expect(page.getByTestId('reader')).toContainText('Vectors that keep their direction')
  await selectText(page, '[data-testid=reader]', 'eigenvalue')
  await page.getByTestId('sel-term').click()
  await page.getByTestId('term-definition').fill('The number that says how much an eigenvector is stretched or shrunk by the matrix.')
  await page.getByTestId('term-submit').click()
  await expect(page.getByTestId('term-popover')).toContainText('matches your materials')

  // Search a passage on the web, in the Browser tab.
  await selectText(page, '[data-testid=reader]', 'characteristic equation')
  await page.getByTestId('sel-search').click()
  await expect(page.getByTestId('tab-browser')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('browser-address')).toHaveValue(/google\.com\/search\?q=characteristic/)

  // --- A lesson is its own chat -------------------------------------------------------------
  await page.getByTestId('tab-lessons').click()
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('chat-title')).toContainText('Lesson:')
  // The chat keeps a pointer; the lesson itself opens in the Study tab, its first reading beside it.
  await expect(page.getByTestId('lesson-widget')).toContainText('checks passed')
  await expect(page.getByTestId('tab-study')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('chat-pane').getByTestId('session-panel')).toHaveCount(0)
  const lesson = page.getByTestId('page-study')
  await expect(lesson.getByTestId('brief')).toBeVisible()
  await expect(page.getByTestId('split-tab-sources')).toHaveAttribute('aria-selected', 'true')
  // Formulas render the same way in the brief as in the chat (one renderer everywhere).
  await expect(lesson.getByTestId('brief').locator('.katex').first()).toBeVisible()
  await shot(page, 'brief')
  await expect(page.getByTestId('sidebar-chat')).toHaveCount(2) // the intake chat (tools ran inside it) and the lesson
  await lesson.getByTestId('phase-next').click()
  await expect(lesson.getByTestId('phase-read')).toHaveClass(/active/)
  await lesson.getByTestId('phase-next').click()
  await expect(lesson.getByTestId('check-prompt').locator('.katex').first()).toBeVisible() // and in the explain check
  const long =
    'An eigenvector is a direction the matrix does not rotate: multiplying it by the matrix only scales it, and the scale factor is the eigenvalue, so A x equals lambda x for that vector.'
  for (const next of ['apply', 'distinguish', 'wrap']) {
    await lesson.getByTestId('check-answer').fill(long)
    await lesson.getByTestId('check-submit').click()
    await expect(lesson.getByTestId('verdict').last()).toContainText('Pass')
    await lesson.getByTestId('phase-next').click()
    await expect(lesson.getByTestId(`phase-${next}`)).toHaveClass(/active/)
  }
  await lesson.getByTestId('finish-session').click()
  await expect(lesson).toContainText('Session complete')
  await expect(page.getByTestId('lesson-widget')).toContainText('complete')
  await page.getByTestId('tab-lessons').click()
  await expect(page.locator('.status-dot.mastered').first()).toBeVisible()

  // --- Notes ---------------------------------------------------------------------------------
  // A plain notepad: past notes, and a rich editor for a new one. It saves as you type.
  await page.getByTestId('tab-notes').click()
  await page.getByTestId('note-new').click()
  await page.getByTestId('note-title').fill('Eigen in my words')
  await expect(page.getByTestId('note-title')).toHaveValue('Eigen in my words')
  const editor = page.getByTestId('note-editor')
  await page.getByTestId('note-title').press('Enter') // Enter moves from the title into the note
  await page.keyboard.type('Eigenvectors are the directions a matrix ')
  await page.getByTestId('fmt-bold').click()
  await page.keyboard.type('only stretches')
  await page.getByTestId('fmt-bold').click()
  await page.keyboard.type('. In symbols: $Av = \\lambda v$ and done.')
  await expect(editor.locator('strong')).toHaveText('only stretches')
  await expect(page.getByTestId('note-title')).toHaveValue('Eigen in my words')
  await expect(editor).toContainText('Eigenvectors are the directions')
  await expect(editor.getByTestId('note-math')).toHaveCount(1)
  await expect(editor.locator('.katex').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await page.getByTestId('fmt-checklist').click()
  await page.keyboard.type('Review on Friday')
  await expect(editor.locator('ul[data-type=taskList] li')).toHaveCount(1)
  await expect(page.getByTestId('note-status')).toHaveText('Saved')
  await shot(page, 'note-editor')
  await page.getByTestId('note-back').click()
  await expect(page.getByTestId('note-row').first().locator('b')).toHaveText('Eigen in my words')
  await expect(page.getByTestId('note-row').first()).toContainText('only stretches')
  await expect(page.getByTestId('note-row').first()).toContainText('and done. Review on Friday')
  // Reopening keeps the formatting; search finds it.
  await page.getByTestId('notes-search').fill('stretches')
  await page.getByTestId('note-row').first().click()
  await expect(page.getByTestId('note-editor').locator('strong')).toHaveText('only stretches')
  await expect(page.getByTestId('note-editor').getByTestId('note-math')).toHaveCount(1)
  await page.getByTestId('note-back').click()
  await page.getByTestId('notes-search').fill('')

  // --- Split the panel: two tabs at once ---------------------------------------------------------
  const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
  // The lesson left its reading open in the split; close it first.
  await page.getByTestId('split-close').click()
  await expect(page.getByTestId('split-head')).toHaveCount(0)
  await page.getByTestId('split-toggle').click()
  await expect(page.getByTestId('split-head')).toBeVisible()
  await expect(page.getByTestId('page-notes')).toHaveClass(/slot-a/)
  await expect(page.getByTestId('page-browser')).toHaveClass(/slot-b/)
  expect((await box('page-browser')).x).toBeGreaterThan((await box('page-notes')).x + 100) // side by side
  // Sources in the split, next to the notes; then stacked.
  await page.getByTestId('split-tab-sources').click()
  await expect(page.getByTestId('page-sources')).toHaveClass(/slot-b/)
  await expect(page.getByTestId('page-sources').getByTestId('reader')).toBeVisible()
  await expect(page.getByTestId('page-browser')).toHaveClass(/inactive/)
  await page.getByTestId('split-dir').click()
  expect((await box('page-sources')).y).toBeGreaterThan((await box('page-notes')).y + 100) // stacked
  // Picking the split's tab in the main tab bar swaps the halves.
  await page.getByTestId('tab-sources').click()
  await expect(page.getByTestId('page-sources')).toHaveClass(/slot-a/)
  await expect(page.getByTestId('page-notes')).toHaveClass(/slot-b/)
  await shot(page, 'split')
  await page.getByTestId('split-dir').click()
  await page.getByTestId('split-close').click()
  await expect(page.getByTestId('split-head')).toHaveCount(0)
  await page.getByTestId('tab-notes').click()

  // --- Swap the chat and the panel; hide the panel --------------------------------------------
  await page.getByTestId('swap').click()
  expect(await page.evaluate(() => document.querySelector('.workspace')!.firstElementChild!.classList.contains('side-panel'))).toBe(true)
  await page.getByTestId('toggle-panel').click()
  await expect(page.getByTestId('panel')).toHaveCount(0)
  await page.getByTestId('toggle-panel').click()
  await page.getByTestId('swap').click()
  await shot(page, 'notes')

  // --- No materials: the tutor finds trusted sources in the chat --------------------------------
  await page.getByTestId('new-class').click()
  await expect(page.getByTestId('chat-hero')).toContainText('What do you want to learn?')
  await say(page, 'I want to learn linear algebra')
  await expect(page.getByTestId('sidebar-class').first()).toContainText('Linear algebra')
  await page.getByTestId('questions-skip').click()
  const proposal = page.getByTestId('proposal').first()
  await expect(proposal).toBeVisible({ timeout: 20_000 })
  await proposal.locator('input[type=checkbox]').check()
  await page.getByTestId('approve-proposals').click()
  await expect(page.getByTestId('plan-widget')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('source-tab')).toHaveCount(1)
  await shot(page, 'trusted')

  // Delete it; the other class opens.
  await page.getByTestId('class-menu').click()
  await page.getByTestId('delete-class').click()
  await expect(page.getByTestId('sidebar-class')).toHaveCount(1)
  await expect(page.getByTestId('panel')).toBeVisible() // the remaining class has loaded
  await expectShellInPlace(page)

  // Settings can put lessons inside their chat instead: then there is no Study tab.
  const openLessonChat = async () => {
    await page.getByTestId('sidebar-class').click()
    await page.getByTestId('sidebar-chat').filter({ hasText: 'Lesson:' }).locator('.chat-open').click()
    await expect(page.getByTestId('chat-title')).toContainText('Lesson:')
  }
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('lessons-in-chat').click()
  await expect(page.getByTestId('lessons-in-chat')).toHaveAttribute('aria-checked', 'true')
  await openLessonChat()
  await expect(page.getByTestId('tab-study')).toHaveCount(0)
  await expect(page.getByTestId('chat-pane').getByTestId('session-panel')).toContainText('Session complete')
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('lessons-in-study').click()
  await openLessonChat()
  await expect(page.getByTestId('tab-study')).toBeVisible()
  await expect(page.getByTestId('chat-pane').getByTestId('session-panel')).toHaveCount(0)

  expect(m.errors.filter((e) => !/Download the React DevTools|Electron Security Warning/.test(e))).toEqual([])
})
