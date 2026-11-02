import { expect, test, type Page } from '@playwright/test'
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

test('a learner goes from intake to mastery using every feature', async () => {
  m = await launch({ pick: [fixture('eigen.md')] })
  const { page } = m

  // --- Settings: offline Demo provider ------------------------------------
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByTestId('provider-demo').click()
  await page.getByTestId('test-provider').click()
  await expect(page.getByTestId('test-result')).toContainText('Demo mode')

  // --- Intake ----------------------------------------------------------------
  await page.getByTestId('new-class').click()
  await page.getByLabel('What do you want to learn?').fill('Linear algebra')
  await page.getByLabel(/Why\?/).fill('I want to follow the math in machine learning papers and build a small recommender.')
  await page.getByLabel(/Success looks like/).fill('Explain eigenvectors to a colleague\nImplement PCA')
  await page.getByTestId('intake-next').click()
  await page.getByLabel('Time you can reliably give').fill('3 hours a week')
  await page.getByTestId('intake-next').click()
  await page.getByRole('button', { name: /My own materials/ }).click()
  await page.getByTestId('intake-create').click()
  await expect(page.getByTestId('mission-card')).toContainText('machine learning papers')
  await shot(page, 'setup-empty')

  // Materials
  await page.getByTestId('add-files').click()
  await expect(page.getByTestId('source-item')).toContainText('Eigenvectors and Eigenvalues')

  // Diagnostic
  await page.getByTestId('start-diagnostic').click()
  const answers = page.getByTestId('diagnostic-answer')
  await expect(answers.first()).toBeVisible()
  await answers.nth(0).fill('I took a linear algebra course years ago and used matrices for graphics transforms in a game.')
  await answers.nth(1).fill("I don't know")
  await page.getByTestId('submit-diagnostic').click()
  await expect(page.getByText('some prior knowledge').or(page.getByText('new to the topic'))).toBeVisible()

  // Curriculum proposal → approve
  await page.getByTestId('plan-curriculum').click()
  await expect(page.getByTestId('curriculum-proposal')).toBeVisible()
  await shot(page, 'curriculum-proposal')
  await page.getByTestId('approve-plan').click()
  await expect(page.getByTestId('tab-path')).toBeVisible()
  await expect(page.getByTestId('topic-row').first()).toBeVisible()
  await shot(page, 'path')

  // --- Study session -----------------------------------------------------------
  await page.getByTestId('start-session').click()
  await expect(page.getByTestId('session-panel')).toBeVisible()
  await expect(page.getByTestId('brief')).toBeVisible()
  await expect(page.getByTestId('reader')).toContainText('Vectors that keep their direction')

  // Highlight → Ask popover (non-modal), streamed answer with a citation chip
  await selectText(page, '[data-testid=reader]', 'stay on the same line through the origin')
  await expect(page.getByTestId('selection-toolbar')).toBeVisible()
  await page.getByTestId('sel-ask').click()
  const pop = page.getByTestId('ask-popover')
  await expect(pop).toBeVisible()
  await pop.getByTestId('ask-input').fill('Why do these vectors stay on their line?')
  await pop.getByTestId('ask-send').click()
  await expect(pop.getByTestId('tutor-message').first()).toBeVisible()
  await expect(pop.locator('.cite-chip').first()).toBeVisible()
  await shot(page, 'ask-popover')
  // The reader stays usable while the popover is open (it is not modal).
  await expect(page.getByTestId('reader')).toBeVisible()

  // Help ladder: deliberately climb one rung
  const rungBefore = await pop.getByTestId('rung-bar').innerText()
  await pop.getByTestId('more-help').click()
  await expect(pop.getByTestId('tutor-message')).toHaveCount(2)
  await expect(pop.getByTestId('rung-bar')).not.toHaveText(rungBefore)

  // Citation chip jumps to the passage
  await pop.locator('.cite-chip').first().click()
  await expect(page.locator('.block.flash, mark.hl.flash-quote').first()).toBeVisible()

  // Follow-up on part of the tutor's reply
  await selectText(page, '[data-testid=ask-popover] [data-testid=tutor-message]', 'Re-read')
    .catch(async () => selectText(page, '[data-testid=ask-popover] [data-testid=tutor-message]', 'passage'))
  await page.getByTestId('ask-followup').click()
  await expect(page.getByTestId('ask-popover')).toContainText('Follow-up on a reply')
  await page.getByTestId('ask-popover').getByTestId('ask-input').fill('What should I look for there?')
  await page.getByTestId('ask-popover').getByTestId('ask-send').click()
  await expect(page.getByTestId('ask-popover').getByTestId('tutor-message').first()).toBeVisible()

  // Minimize → sticky pin in the margin, reopen it
  await page.getByTestId('popover-minimize').click()
  await expect(page.getByTestId('ask-popover')).toHaveCount(0)
  await expect(page.getByTestId('pin-thread').first()).toBeVisible()
  await page.getByTestId('pin-thread').first().click()
  await expect(page.getByTestId('ask-popover').getByTestId('tutor-message').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ask-popover')).toHaveCount(0)

  // Highlight and sticky note
  await selectText(page, '[data-testid=reader]', 'The amount of stretching is a number called the eigenvalue')
  await page.getByTestId('sel-highlight').click()
  await expect(page.locator('mark.hl:not(.thread):not(.note)').first()).toBeVisible()
  await selectText(page, '[data-testid=reader]', 'A x equals lambda x')
  await page.getByTestId('sel-note').click()
  await expect(page.getByTestId('note-popover')).toBeVisible()
  await page.getByTestId('note-input').fill('The core equation: matrix times vector equals a number times the same vector.')
  await page.getByTestId('note-save').click()
  await expect(page.getByTestId('pin-note').first()).toBeVisible()
  await shot(page, 'note-pin')

  // Glossary term (learner defines it; tutor checks)
  await selectText(page, '[data-testid=reader]', 'eigenvalue')
  await page.getByTestId('sel-term').click()
  await page.getByTestId('term-definition').fill('The number that says how much an eigenvector is stretched or shrunk by the matrix.')
  await page.getByTestId('term-submit').click()
  await expect(page.getByTestId('term-popover')).toContainText('matches your materials')
  await expect(page.getByTestId('term-popover')).toHaveCount(0)

  // Interactive diagram from a selection; click a part to ask about it
  await selectText(page, '[data-testid=reader]', 'Most vectors change direction when a matrix multiplies them')
  await page.getByTestId('sel-diagram').click()
  await expect(page.getByTestId('diagram-panel')).toBeVisible()
  const frameEl = page.locator('.diagram-stage iframe')
  await expect(frameEl).toBeVisible()
  const sandbox = page.frameLocator('.diagram-stage iframe')
  await expect(sandbox.locator('canvas').first()).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('diagram-keep').click()
  // Click the origin dot (center-x, 70% height of the canvas) inside the sandbox.
  // Let the canvas settle into the widened diagram panel before clicking.
  await page.waitForTimeout(800)
  const settled = await sandbox.locator('canvas').first().boundingBox()
  await page.mouse.click(settled!.x + settled!.width / 2, settled!.y + settled!.height * 0.7)
  await expect(page.getByTestId('ask-popover')).toContainText('Diagram')
  await page.getByTestId('ask-popover').getByTestId('ask-input').fill('What is this point?')
  await page.getByTestId('ask-popover').getByTestId('ask-send').click()
  await expect(page.getByTestId('ask-popover').getByTestId('tutor-message').first()).toBeVisible()
  await shot(page, 'diagram-ask')
  await page.keyboard.press('Escape')

  // --- The session loop: brief → read → explain → apply → distinguish → wrap ---
  await page.getByTestId('side-session').click()
  await page.getByTestId('phase-next').click() // Start reading
  await expect(page.getByTestId('phase-read')).toHaveClass(/active/)
  await page.getByTestId('phase-next').click() // Ready to explain
  await expect(page.getByTestId('phase-explain')).toHaveClass(/active/)
  const long =
    'An eigenvector is a direction the matrix does not rotate: multiplying it by the matrix only scales it, and the scale factor is the eigenvalue, so A x equals lambda x for that vector.'
  for (let i = 0; i < 3; i++) {
    await expect(page.getByTestId('check-answer')).toBeVisible()
    await page.getByTestId('check-answer').fill(long)
    await page.getByTestId('check-submit').click()
    await expect(page.getByTestId('verdict').last()).toContainText('Pass')
    const nextPhase = ['apply', 'distinguish', 'wrap'][i]
    await page.getByTestId('phase-next').click()
    await expect(page.getByTestId(`phase-${nextPhase}`)).toHaveClass(/active/)
  }
  await expect(page.getByTestId('wrap')).toBeVisible()
  await shot(page, 'wrap')
  await page.getByTestId('finish-session').click()
  await expect(page.getByTestId('tab-path')).toBeVisible()
  await expect(page.locator('.status-dot.mastered').first()).toBeVisible()

  // --- Progress -------------------------------------------------------------------
  await page.getByTestId('tab-progress').click()
  await expect(page.getByTestId('independence-card')).toBeVisible()
  await expect(page.getByTestId('records')).toContainText('LR-0001')
  await shot(page, 'progress')

  // --- Notebook -------------------------------------------------------------------
  await page.getByTestId('tab-notebook').click()
  await page.getByTestId('note-title').fill('Eigen in my words')
  await page.getByTestId('note-body').fill('Eigenvectors are the directions a matrix only stretches. The eigenvalue is how much.')
  await page.getByTestId('note-save-btn').click()
  await page.getByTestId('note-review').click()
  await expect(page.getByText('Tutor review')).toBeVisible()
  await page.getByTestId('nb-stickies').click()
  await expect(page.getByTestId('nb-thread').first()).toBeVisible()
  await page.getByTestId('nb-glossary').click()
  await expect(page.getByTestId('glossary-term').first()).toBeVisible()
  await page.getByTestId('nb-reference').click()
  // Authorship fades with independence: the tutor drafts only for less independent learners.
  if (await page.getByTestId('draft-reference').count()) {
    await page.getByTestId('draft-reference').click()
    await expect(page.getByText('Tutor draft. Rewrite it')).toBeVisible()
  } else {
    await expect(page.getByText('write reference sheets yourself')).toBeVisible()
  }
  await shot(page, 'reference')
  await page.getByTestId('nb-explorables').click()
  await expect(page.locator('.class-card').first()).toBeVisible()

  // --- Library: trusted-source fallback --------------------------------------------
  await page.getByTestId('tab-library').click()
  await page.getByTestId('find-trusted').click()
  await expect(page.getByTestId('proposal').first()).toBeVisible()
  await page.getByTestId('proposal').first().locator('input[type=checkbox]').check()
  await page.getByTestId('approve-proposals').click()
  await expect(page.getByTestId('source-item').filter({ hasText: 'Found by mint' })).toHaveCount(1, { timeout: 20_000 })
  await shot(page, 'library')

  expect(m.errors.filter((e) => !/Download the React DevTools|Electron Security Warning/.test(e))).toEqual([])
})
