// Firefox QA harness for the min-bend app.
//
// Usage:
//   1. start the dev server:  npm run dev        (http://localhost:5173/)
//   2. run:                   node qa/qa-firefox.cjs
//
// Env overrides:
//   QA_BASE_URL       app under test (default http://localhost:5173/)
//   QA_OUT_DIR        screenshot output dir (default qa/artifacts, git-ignored)
//   PLAYWRIGHT_CORE   explicit path to a playwright-core install
const path = require('node:path')
const fs = require('node:fs')

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE
  try {
    return require.resolve('playwright-core')
  } catch {
    return '/home/marian/.npm/_npx/420ff84f11983ee5/node_modules/playwright-core'
  }
}
const { firefox } = require(resolvePlaywright())

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:5173/'
const OUT_DIR = process.env.QA_OUT_DIR || path.join(__dirname, 'artifacts')
fs.mkdirSync(OUT_DIR, { recursive: true })
const shot = (name) => path.join(OUT_DIR, name)

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

let failures = 0
function check(name, cond, extra = '') {
  if (!cond) failures++
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ` — ${extra}` : ''}`)
}

;(async () => {
  const browser = await firefox.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  const fieldInput = (labelText) =>
    page.locator('.field', { hasText: labelText }).locator('input').first()
  const vecInput = (groupLabel, axis) =>
    page.locator(`[role="group"][aria-label="${groupLabel}"] .field`, { hasText: axis }).locator('input').first()
  const computeBtn = page.locator('.sidebar__actions button.btn--primary')
  const counter = async () => norm(await page.textContent('.pose-editor__counter'))

  try {
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 })
    await page.waitForSelector('h1.app__title', { timeout: 10000 })

    check('App title', (await page.textContent('h1.app__title')).includes('Minimum-Bend'))
    check('Sidebar visible', await page.isVisible('aside.sidebar'))
    check('Setup editor visible', await page.isVisible('.pose-editor'))

    check('Editor: span 1 has 4 free slots', (await counter()) === 'span 1: 0 / 4 free points', await counter())
    check('Default n = 6', (await fieldInput('Interior points per span').inputValue()) === '6')
    check('Two fix points present', (await page.locator('.fix-item').count()) === 2)
    check('Fix point 1 is the start', (await page.locator('.fix-item').first().textContent()).includes('Fix point 1'))
    check('Both orientations on by default', (await page.locator('.fix-item .switch input:checked').count()) === 2)

    const endX = await vecInput('Fix point 2 position', 'X').inputValue()
    const endY = await vecInput('Fix point 2 position', 'Y').inputValue()
    check('Default end fix point = [0,0]', endX === '0' && endY === '0', `end=(${endX}, ${endY})`)

    check('Compute enabled initially', await computeBtn.isEnabled())

    // --- Validation: zero fix-point orientation ---
    await vecInput('Fix point 1 orientation', 'X').fill('0')
    await vecInput('Fix point 1 orientation', 'Y').fill('0')
    await page.waitForTimeout(200)
    const orientErr = page.locator('.fix-item', { hasText: 'Fix point 1' }).locator('.group__error[role="alert"]')
    check('Validation: zero-orientation error shown', await orientErr.isVisible())
    check('Validation: Compute disabled', !(await computeBtn.isEnabled()))
    await page.screenshot({ path: shot('qa-1-validation.png') })

    await vecInput('Fix point 1 orientation', 'Y').fill('1')
    await page.waitForTimeout(200)
    check('Validation: Compute re-enabled after fix', await computeBtn.isEnabled())
    await page.screenshot({ path: shot('qa-2-idle.png') })

    // --- Editor: place / undo / redo / cap / clear ---
    const editorCanvas = page.locator('.pose-editor__canvas canvas')
    const box = await editorCanvas.boundingBox()
    check('Editor: canvas present', !!box)
    if (box) {
      const at = (fx, fy) => ({ x: Math.round(box.width * fx), y: Math.round(box.height * fy) })
      await editorCanvas.click({ position: at(0.4, 0.45) })
      check('Editor: click places 1', (await counter()) === 'span 1: 1 / 4 free points', await counter())
      await editorCanvas.click({ position: at(0.55, 0.55) })
      check('Editor: click places 2', (await counter()) === 'span 1: 2 / 4 free points', await counter())
      await page.locator('[data-action="undo"]').click()
      check('Editor: undo -> 1', (await counter()) === 'span 1: 1 / 4 free points', await counter())
      await page.locator('[data-action="redo"]').click()
      check('Editor: redo -> 2', (await counter()) === 'span 1: 2 / 4 free points', await counter())
      await editorCanvas.click({ position: at(0.45, 0.42) })
      await editorCanvas.click({ position: at(0.5, 0.62) })
      check('Editor: fills to 4', (await counter()) === 'span 1: 4 / 4 free points', await counter())
      await editorCanvas.click({ position: at(0.6, 0.5) })
      check('Editor: capacity caps at 4', (await counter()) === 'span 1: 4 / 4 free points', await counter())
      await page.locator('[data-action="clear"]').click()
      check('Editor: clear -> 0', (await counter()) === 'span 1: 0 / 4 free points', await counter())
    }
    await page.screenshot({ path: shot('qa-2b-editor.png') })

    // --- Per-curve target path length (optional constraint) ---
    const targetSwitch = page
      .locator('.curve-card')
      .first()
      .locator('label.switch', { hasText: 'Constrain path length' })
      .locator('input')
    check(
      'Target length: switch present and off',
      (await targetSwitch.count()) === 1 && !(await targetSwitch.isChecked()),
    )
    const targetField = () =>
      page.locator('.curve-card').first().locator('.field', { hasText: 'Target path length' }).locator('input').first()
    check('Target length: field hidden while off', (await targetField().count()) === 0)
    await targetSwitch.check()
    await page.waitForTimeout(150)
    check('Target length: field appears when enabled', (await targetField().count()) === 1)
    const prefilled = await targetField().inputValue()
    check('Target length: prefilled with a positive length', Number(prefilled) > 0, `prefill=${prefilled}`)
    await targetField().fill('0')
    await page.waitForTimeout(200)
    check('Target length: zero flagged invalid', (await targetField().getAttribute('aria-invalid')) === 'true')
    check('Target length: Compute disabled while invalid', !(await computeBtn.isEnabled()))
    await targetField().fill('20')
    await page.waitForTimeout(200)
    check('Target length: Compute re-enabled', await computeBtn.isEnabled())
    await page.screenshot({ path: shot('qa-2c-target.png') })
    await targetSwitch.uncheck()
    await page.waitForTimeout(150)
    check('Target length: field hidden when disabled', (await targetField().count()) === 0)

    // --- Default compute -> success ---
    await computeBtn.click()
    const sawRunning = await page
      .waitForSelector('aside .bar[role="progressbar"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    check('Running: progress bar appears', sawRunning)

    await page.waitForSelector('.notice--success', { timeout: 60000 })
    const successText = norm(await page.textContent('.notice--success'))
    check('Success: converged notice', /Converged/.test(successText), successText)
    check('Success: player visible', await page.isVisible('.player'))
    const hud = norm(await page.textContent('.player__hud'))
    check('HUD: 1 curve', hud.includes('1 curve'), hud)
    check('HUD: 8 pts', hud.includes('8 pts'), hud)

    const frameNum = async () => {
      const t = norm(await page.textContent('.frame-label'))
      const m = t.match(/frame ([\d,]+) \/ ([\d,]+)/)
      const num = (s) => Number(String(s).replace(/,/g, ''))
      return m ? { cur: num(m[1]), tot: num(m[2]) } : { cur: -1, tot: -1 }
    }

    check('Playback: paused at mount', await page.getByRole('button', { name: 'Play', exact: true }).isVisible())
    await page.locator('.scrub').focus()
    await page.locator('.scrub').press('Home')
    await page.waitForTimeout(150)
    const restA = await frameNum()
    await page.waitForTimeout(400)
    const restB = await frameNum()
    check('Playback: paused player stays put', restA.cur === restB.cur, `f=${restA.cur}`)
    const { cur, tot } = await frameNum()
    check('Player: frame 1 of N', cur === 1 && tot > 1, `N=${tot}`)

    const canvasScale = () => page.evaluate(() => Number(document.querySelector('canvas')?.dataset.scale || '-1'))
    const scaleFrame1 = await canvasScale()
    check('Plot scale: positive at frame 1', scaleFrame1 > 0, `scale=${scaleFrame1}`)

    // --- Segment profile plot (wide + short) ---
    const plotSig = () =>
      page.evaluate(() => {
        const c = document.querySelector('.player__plot canvas')
        if (!c) return -1
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let s = 0
        for (let i = 0; i < d.length; i += 4 * 37) s = (s * 31 + d[i] + d[i + 1] * 7) % 2147483647
        return s
      })
    const plotBox = await page.locator('.player__plot').boundingBox().catch(() => null)
    check('Plot: wrapper present', !!plotBox)
    check(
      'Plot: much wider than high',
      !!plotBox && plotBox.width > plotBox.height * 1.8,
      plotBox ? `w=${Math.round(plotBox.width)} h=${Math.round(plotBox.height)}` : 'no box',
    )
    const plotSigFrame1 = await plotSig()
    check('Plot: canvas painted at frame 1', plotSigFrame1 > 0, `sig=${plotSigFrame1}`)

    const plotAgg = () =>
      page.evaluate(() => {
        const c = document.querySelector('.player__plot canvas')
        return c ? { avg: Number(c.dataset.avgLength), bend: Number(c.dataset.maxBend) } : { avg: NaN, bend: NaN }
      })
    const aggFirst = await plotAgg()
    check('Plot: avg length exposed', Number.isFinite(aggFirst.avg) && aggFirst.avg > 0, `avg=${aggFirst.avg}`)
    check('Plot: max bend exposed', Number.isFinite(aggFirst.bend) && aggFirst.bend > 0, `bend=${aggFirst.bend}`)

    // --- Speed ---
    const speedLabel = page.locator('.speed-label')
    check('Speed: starts at 1×', norm(await speedLabel.textContent()) === '1×')
    await page.getByLabel('Speed up').click()
    await page.getByLabel('Speed up').click()
    check('Speed: 2× clicks -> 4×', norm(await speedLabel.textContent()) === '4×')
    await page.getByLabel('Slow down').click()
    check('Speed: back to 2×', norm(await speedLabel.textContent()) === '2×')

    // --- Playback advances ---
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    const canvasPainted = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return false
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const r0 = d[0]
      const g0 = d[1]
      const b0 = d[2]
      let diff = 0
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] !== r0 || d[i + 1] !== g0 || d[i + 2] !== b0) diff++
      return diff > 10
    })
    check('Player: canvas painted', canvasPainted)
    await page.screenshot({ path: shot('qa-3-player.png') })

    await page.waitForTimeout(900)
    const afterPlay = await frameNum()
    check('Playback: Play advances frames', afterPlay.cur > 1, `frame=${afterPlay.cur}`)
    const plotSigLater = await plotSig()
    check('Plot: animates with frame', plotSigLater > 0 && plotSigLater !== plotSigFrame1, `f1=${plotSigFrame1} f${afterPlay.cur}=${plotSigLater}`)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.waitForTimeout(200)
    const pausedFrame = await frameNum()
    await page.waitForTimeout(400)
    check('Playback: pause freezes frames', (await frameNum()).cur === pausedFrame.cur, `f=${pausedFrame.cur}`)
    await page.screenshot({ path: shot('qa-4-playback.png') })

    // --- Scrubber ---
    await page.locator('.scrub').focus()
    await page.locator('.scrub').press('End')
    await page.waitForTimeout(150)
    const atEnd = await frameNum()
    check('Scrubber: End -> last frame', atEnd.cur === atEnd.tot, JSON.stringify(atEnd))
    const aggLast = await plotAgg()
    check(
      'Plot: aggregates recompute per frame',
      Number.isFinite(aggLast.avg) &&
        Number.isFinite(aggLast.bend) &&
        aggLast.avg > 0 &&
        (aggLast.bend !== aggFirst.bend || aggLast.avg !== aggFirst.avg),
      `first avg=${aggFirst.avg.toFixed(3)} | last avg=${aggLast.avg.toFixed(3)}`,
    )
    await page.locator('.scrub').press('Home')
    await page.waitForTimeout(150)
    check('Scrubber: Home -> first frame', (await frameNum()).cur === 1)

    // --- First / last jump buttons ---
    await page.getByLabel('Jump to last frame').click()
    await page.waitForTimeout(150)
    const jumped = await frameNum()
    check('Jump: last frame', jumped.cur === jumped.tot, JSON.stringify(jumped))
    await page.getByLabel('Jump to first frame').click()
    await page.waitForTimeout(150)
    check('Jump: first frame', (await frameNum()).cur === 1)

    // --- Keyboard ---
    await page.locator('.player').focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(500)
    const afterSpace = await frameNum()
    check('Keyboard: Space plays', afterSpace.cur > 1, `frame=${afterSpace.cur}`)
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(150)
    check('Keyboard: ArrowRight steps', (await frameNum()).cur >= afterSpace.cur)

    // --- Split x / y view (R12) ---
    const splitBtn = page.getByLabel('Split x and y coordinates')
    check('Split: default off', (await splitBtn.getAttribute('aria-pressed')) === 'false')
    await splitBtn.click()
    await page.waitForTimeout(200)
    check('Split: two coordinate plots', (await page.locator('.coordinate-plot').count()) === 2)
    check('Split: frame canvas hidden', (await page.locator('.frame-canvas').count()) === 0)
    await page.screenshot({ path: shot('qa-7-split.png') })
    await splitBtn.click()
    await page.waitForTimeout(200)
    check('Split: back to combined', (await page.locator('.coordinate-plot').count()) === 0)

    // --- Loop toggle ---
    const loopBtn = page.getByLabel('Loop playback')
    check('Loop: default OFF', (await loopBtn.getAttribute('aria-pressed')) === 'false')
    await loopBtn.click()
    check('Loop: toggles ON', (await loopBtn.getAttribute('aria-pressed')) === 'true')
    await loopBtn.click()

    // --- Multi-curve (R4) ---
    await page.locator('button:has-text("Edit setup")').click()
    await page.waitForSelector('.pose-editor')
    check('Multi: back to editor', await page.isVisible('.pose-editor'))
    await page.locator('button:has-text("Add curve")').click()
    check('Multi: two curve cards', (await page.locator('.curve-card').count()) === 2)
    check('Multi: two editor curve tabs', (await page.locator('.chip-row[aria-label="Curves"] .chip').count()) === 2)
    await computeBtn.click()
    await page.waitForSelector('.notice--success', { timeout: 90000 })
    const hud2 = norm(await page.textContent('.player__hud'))
    check('Multi: HUD shows 2 curves', hud2.includes('2 curves'), hud2)
    check('Multi: player curve selector has 2 chips', (await page.locator('.player .chip-row--view .chip').count()) === 2)
    await page.screenshot({ path: shot('qa-8-multicurve.png') })

    // --- Hide a curve from the player (R2) ---
    const viewChips = page.locator('.player .chip-row--view .curve-chip')
    check('Hide: two curve chips in the player', (await viewChips.count()) === 2)
    check('Hide: eye toggle on every chip', (await page.locator('.player .curve-chip__eye').count()) === 2)
    const chip2 = viewChips.nth(1)
    const eye2 = chip2.locator('.curve-chip__eye')
    check('Hide: curve 2 starts shown', (await eye2.getAttribute('aria-pressed')) === 'false')
    await eye2.click()
    await page.waitForTimeout(120)
    check('Hide: curve 2 chip marked hidden', ((await chip2.getAttribute('class')) || '').includes('is-hidden'))
    check('Hide: curve 2 eye reports hidden', (await eye2.getAttribute('aria-pressed')) === 'true')
    check(
      'Hide: frame canvas still painted',
      await page
        .locator('.frame-canvas canvas')
        .evaluate((c) => Number(c.dataset.scale) > 0)
        .catch(() => false),
    )
    const storedHidden = await page.evaluate(() => {
      const raw = localStorage.getItem('min-bend:state')
      return raw ? JSON.parse(raw) : null
    })
    check('Hide: hidden flag persisted', storedHidden?.setup?.curves?.[1]?.hidden === true)
    await page.screenshot({ path: shot('qa-9-hidden.png') })

    // --- Create a new curve from the solved frame (R3) ---
    const fromFrameBtn = page.locator('button:has-text("Curve from frame")')
    check('Create-from-frame: button present in player', (await fromFrameBtn.count()) === 1)
    await fromFrameBtn.click()
    await page.waitForSelector('.pose-editor')
    check('Create-from-frame: returns to the editor', await page.isVisible('.pose-editor'))
    check('Create-from-frame: appended a curve', (await page.locator('.curve-card').count()) === 3)
    const srcN = Number(
      await page
        .locator('.curve-card')
        .first()
        .locator('.field', { hasText: 'Interior points per span' })
        .locator('input')
        .first()
        .inputValue(),
    )
    const srcFix = await page.locator('.curve-card').first().locator('.fix-item').count()
    const expectedPts = (srcFix - 1) * (srcN + 1) + 1
    const newCard = page.locator('.curve-card').nth(2)
    const newN = await newCard
      .locator('.field', { hasText: 'Interior points per span' })
      .locator('input')
      .first()
      .inputValue()
    const newFix = await newCard.locator('.fix-item').count()
    check('Create-from-frame: new curve is fully fixed (n = 0)', newN === '0', `n=${newN}`)
    check(
      'Create-from-frame: fix points equal the copied polyline length',
      newFix === expectedPts,
      `new=${newFix} expected=${expectedPts}`,
    )
    await page.screenshot({ path: shot('qa-9-fromframe.png') })

    // --- Slow compute -> cancel ---
    await page.locator('button:has-text("Advanced constants")').click()
    const settleInput = page.getByRole('textbox', { name: 'Settle frames' })
    check('Advanced: Settle frames present', await settleInput.isVisible().catch(() => false))
    if (await settleInput.isVisible().catch(() => false)) {
      check('Advanced: Settle frames default 30', (await settleInput.inputValue()) === '30')
    }
    check('Advanced: no Mute frames field', (await page.getByRole('textbox', { name: 'Mute frames' }).count()) === 0)
    await page.getByRole('textbox', { name: 'Max iterations' }).fill('50000000')
    await page.getByRole('textbox', { name: 'KE threshold ε' }).fill('0')
    await computeBtn.click()
    const cancelVisible = await page
      .waitForSelector('aside button:has-text("Cancel")', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    check('Cancel run: Cancel button appears', cancelVisible)
    const ringPct = await page
      .locator('.ring__percent')
      .textContent()
      .catch(() => null)
    const runPct = ringPct ? Number(norm(ringPct).replace('%', '')) : NaN
    check('Progress: ring stays below 100% while running', Number.isFinite(runPct) && runPct < 100, `pct=${ringPct}`)
    await page.locator('aside button:has-text("Cancel")').first().click()
    await page.waitForSelector('.notice--warn', { timeout: 8000 })
    check('Cancel: cancelled notice shown', /cancelled/i.test(norm(await page.textContent('.notice--warn'))))
    check('Cancel: setup editor restored', await page.isVisible('.pose-editor'))
    check('Cancel: Compute re-enabled', await computeBtn.isEnabled())
    await page.screenshot({ path: shot('qa-5-cancelled.png') })

    // --- Persistence across reload (R4) ---
    const storedBeforeReload = await page.evaluate(() => {
      const raw = localStorage.getItem('min-bend:state')
      return raw ? JSON.parse(raw) : null
    })
    const storedCurves = storedBeforeReload?.setup?.curves ?? []
    check('Persistence: three curves stored', storedCurves.length === 3, `n=${storedCurves.length}`)
    check('Persistence: hidden flag stored', storedCurves[1]?.hidden === true)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.pose-editor')
    check('Persistence: curve count restored', (await page.locator('.curve-card').count()) === 3)
    await page.locator('button:has-text("Advanced constants")').click()
    check(
      'Persistence: constants restored',
      (await page.getByRole('textbox', { name: 'Max iterations' }).inputValue()) === '50000000',
    )
    await page.locator('button:has-text("Advanced constants")').click()

    // --- Reset to defaults (R4) ---
    await page.locator('.sidebar__section-actions button:has-text("Reset")').click()
    await page.waitForTimeout(150)
    check('Reset: back to a single default curve', (await page.locator('.curve-card').count()) === 1)
    check('Reset: default n = 6', (await fieldInput('Interior points per span').inputValue()) === '6')
    const storedAfterReset = await page.evaluate(() => {
      const raw = localStorage.getItem('min-bend:state')
      return raw ? JSON.parse(raw) : null
    })
    check(
      'Reset: hidden flags cleared in storage',
      !(storedAfterReset?.setup?.curves ?? []).some((c) => c.hidden),
    )
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.pose-editor')
    check('Reset: defaults persist after reload', (await page.locator('.curve-card').count()) === 1)
    await page.screenshot({ path: shot('qa-11-reset.png') })

    // --- Console health ---
    await page.waitForTimeout(300)
    const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e))
    check('No console/page errors', realErrors.length === 0, realErrors.join(' | ').slice(0, 300))
    console.log(`      (captured ${consoleErrors.length} console error message(s))`)
  } catch (err) {
    failures++
    console.log(`[FAIL] Unhandled error: ${err.message}`)
    await page.screenshot({ path: shot('qa-error.png') }).catch(() => {})
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\n=== ALL QA CHECKS PASSED ===' : `\n=== ${failures} QA CHECK(S) FAILED ===`)
  process.exit(failures === 0 ? 0 : 1)
})()
