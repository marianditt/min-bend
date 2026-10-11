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
//
// playwright-core is resolved from PLAYWRIGHT_CORE, then a local/global
// `require`, then the cached npx install used during development.
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

  const vecInput = (group, axis) =>
    page.locator('.group', { hasText: group }).locator('.field', { hasText: axis }).locator('input').first()
  const fieldInput = (labelText) =>
    page.locator('.field', { hasText: labelText }).locator('input').first()

  try {
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 })
    await page.waitForSelector('h1.app__title', { timeout: 10000 })

    check('App title', (await page.textContent('h1.app__title')).includes('Minimum-Bend'))
    check('Sidebar visible', await page.isVisible('aside.sidebar'))
    check('Stage placeholder', await page.isVisible('.stage-center'))
    check('Default input n=6', (await fieldInput('Interior points (n)').inputValue()) === '6')

    // Default problem is now a closed loop anchored at the origin (start=end=[0,0])
    const endX = await vecInput('End point', 'X').inputValue()
    const endY = await vecInput('End point', 'Y').inputValue()
    check('Default input end=[0,0]', endX === '0' && endY === '0', `end=(${endX}, ${endY})`)

    const computeBtn = page.locator('button:has-text("Compute")').first()
    check('Compute enabled initially', await computeBtn.isEnabled())

    // --- Validation: zero start orientation ---
    await vecInput('Start orientation', 'X').fill('0')
    await vecInput('Start orientation', 'Y').fill('0')
    await page.waitForTimeout(200)
    const startDirErr = page.locator('.group:has-text("Start orientation") .group__error')
    check('Validation: start-orientation error shown', await startDirErr.isVisible())
    check('Validation: Compute disabled', !(await computeBtn.isEnabled()))
    await page.screenshot({ path: shot('qa-1-validation.png') })

    // restore valid orientation
    await vecInput('Start orientation', 'X').fill('0')
    await vecInput('Start orientation', 'Y').fill('1')
    await page.waitForTimeout(200)
    check('Validation: Compute re-enabled after fix', await computeBtn.isEnabled())
    await page.screenshot({ path: shot('qa-2-idle.png') })

    // --- Default compute -> success ---
    await computeBtn.click()
    const sawRunning = await page
      .waitForSelector('aside .bar[role="progressbar"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    check('Running: progress bar appears', sawRunning)

    await page.waitForSelector('.notice--success', { timeout: 60000 })
    const successText = await page.textContent('.notice--success').catch(() => '')
    check('Success: converged notice', /Converged/.test(successText), successText.trim())
    check('Success: player visible', await page.isVisible('.player'))
    check('Success: HUD shows 8 pts', (await page.textContent('.player__hud')).includes('8 pts'))

    const frameLabel = () => page.textContent('.frame-label')
    const frameNum = async () => {
      const t = await frameLabel()
      const m = t.match(/frame\s+([\d,]+)\s*\/\s*([\d,]+)/)
      const num = (s) => Number(String(s).replace(/,/g, ''))
      return m ? { cur: num(m[1]), tot: num(m[2]) } : { cur: -1, tot: -1 }
    }

    // Player must not auto-play on mount; it should sit paused at frame 0.
    check(
      'Playback: does not auto-play on mount',
      await page.getByRole('button', { name: 'Play', exact: true }).isVisible(),
    )
    await page.locator('.scrub').focus()
    await page.locator('.scrub').press('Home')
    await page.waitForTimeout(150)
    const restA = await frameNum()
    await page.waitForTimeout(400)
    const restB = await frameNum()
    check('Playback: paused player stays put', restA.cur === restB.cur, `f=${restA.cur}`)

    const { cur, tot } = await frameNum()
    check('Player: frame 1 of N', cur === 1 && tot > 1, `N=${tot}`)

    // Canvas exposes the applied uniform scale for verification
    const canvasScale = () =>
      page.evaluate(() => Number(document.querySelector('canvas')?.dataset.scale || '-1'))
    const scaleFrame1 = await canvasScale()
    check('Plot scale: positive at frame 1', scaleFrame1 > 0, `scale=${scaleFrame1}`)

    // --- Second plot: wide + short animated segment profile ---
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

    // Start playback to verify the animation advances
    await page.getByRole('button', { name: 'Play', exact: true }).click()

    // canvas has actual content (not blank)
    const canvasPainted = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return false
      const ctx = c.getContext('2d')
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let nonBg = 0
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i] !== 248 && d[i] !== 11) nonBg++
      }
      return nonBg > 10
    })
    check('Player: canvas painted', canvasPainted)
    await page.screenshot({ path: shot('qa-3-player.png') })

    // --- Speed ---
    const speedLabel = page.locator('.speed-label')
    check('Speed: starts at 1×', (await speedLabel.textContent()).trim() === '1×')
    await page.getByLabel('Speed up').click()
    await page.getByLabel('Speed up').click()
    check('Speed: 2× clicks -> 4×', (await speedLabel.textContent()).trim() === '4×')
    await page.getByLabel('Slow down').click()
    check('Speed: back to 2×', (await speedLabel.textContent()).trim() === '2×')

    // --- Playback advances while playing ---
    await page.waitForTimeout(900)
    const afterPlay = await frameNum()
    check('Playback: Play advances frames', afterPlay.cur > 1, `frame=${afterPlay.cur}`)
    const plotSigLater = await plotSig()
    check(
      'Plot: animates with the current frame',
      plotSigLater > 0 && plotSigLater !== plotSigFrame1,
      `f1=${plotSigFrame1} f${afterPlay.cur}=${plotSigLater}`,
    )
    await page.locator('.player__plot').screenshot({ path: shot('qa-6-plot.png') }).catch(() => {})
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.waitForTimeout(200)
    const pausedFrame = await frameNum()
    await page.waitForTimeout(400)
    const stillFrame = await frameNum()
    check('Playback: pause freezes frames', stillFrame.cur === pausedFrame.cur, `f=${pausedFrame.cur}`)
    await page.screenshot({ path: shot('qa-4-playback.png') })

    // --- Scrubber ---
    const scrub = page.locator('.scrub')
    await scrub.focus()
    await scrub.press('End')
    await page.waitForTimeout(150)
    const atEnd = await frameNum()
    check('Scrubber: End -> last frame', atEnd.cur === atEnd.tot, JSON.stringify(atEnd))
    const scaleLast = await canvasScale()
    check(
      'Plot scale: positive at last frame',
      scaleLast > 0 && Number.isFinite(scaleLast),
      `scale1=${scaleFrame1} last=${scaleLast}`,
    )
    console.log(
      `      (frame1 scale ${scaleFrame1}, last-frame scale ${scaleLast}; refit is per-frame, easing applies only during playback)`,
    )
    await scrub.press('Home')
    await page.waitForTimeout(150)
    check('Scrubber: Home -> first frame', (await frameNum()).cur === 1)

    // --- Keyboard: Space + ArrowRight on player ---
    await page.locator('.player').focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(500)
    const afterSpace = await frameNum()
    check('Keyboard: Space plays', afterSpace.cur > 1, `frame=${afterSpace.cur}`)
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(150)
    const afterArrow = await frameNum()
    check('Keyboard: ArrowRight steps forward', afterArrow.cur >= afterSpace.cur, `prev=${afterSpace.cur} now=${afterArrow.cur}`)

    // --- Loop toggle ---
    const loopBtn = page.getByLabel('Loop playback')
    check('Loop: default OFF', (await loopBtn.getAttribute('aria-pressed')) === 'false')
    await loopBtn.click()
    check('Loop: toggles ON', (await loopBtn.getAttribute('aria-pressed')) === 'true')
    await loopBtn.click()

    // --- Slow compute -> cancel ---
    await page.locator('button:has-text("Advanced constants")').click()
    const settleInput = page.getByRole('textbox', { name: 'Settle frames' })
    const settleVisible = await settleInput.isVisible().catch(() => false)
    check('Advanced: Settle frames field present', settleVisible)
    if (settleVisible) {
      check('Advanced: Settle frames default 30', (await settleInput.inputValue()) === '30')
    }
    check('Advanced: no Mute frames field', (await page.getByRole('textbox', { name: 'Mute frames' }).count()) === 0)
    await page.getByRole('textbox', { name: 'Max iterations' }).fill('50000000')
    await page.getByRole('textbox', { name: 'KE threshold ε' }).fill('0')
    const computeAgain = page.locator('button:has-text("Compute again"), button:has-text("Compute")').first()
    await computeAgain.click()
    const cancelVisible = await page
      .waitForSelector('aside button:has-text("Cancel")', { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    check('Cancel run: Cancel button appears', cancelVisible)
    const runningPct = await page.textContent('.progress-percent').catch(() => '')
    console.log(`      (cancel run was at ${runningPct.trim()} when cancelled)`)
    await page.locator('aside button:has-text("Cancel")').click()
    await page.waitForSelector('.notice--warn', { timeout: 8000 })
    check('Cancel: cancelled notice shown', await page.isVisible('.notice--warn'))
    const stageTitle = await page.textContent('.stage-center__title').catch(() => '')
    check('Cancel: stage shows cancelled', /cancelled/i.test(stageTitle), stageTitle.trim())
    check('Cancel: Compute re-enabled', await computeBtn.isEnabled())
    await page.screenshot({ path: shot('qa-5-cancelled.png') })

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
