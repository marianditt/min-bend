// Live deployment smoke test for the min-bend app.
//
// Usage:  node qa/qa-live-smoke.cjs
//
// Env overrides:
//   QA_LIVE_URL      site under test (default https://marianditt.github.io/min-bend/)
//   PLAYWRIGHT_CORE  explicit path to a playwright-core install
function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE
  try {
    return require.resolve('playwright-core')
  } catch {
    return '/home/marian/.npm/_npx/420ff84f11983ee5/node_modules/playwright-core'
  }
}
const { firefox } = require(resolvePlaywright())

const LIVE_URL = process.env.QA_LIVE_URL || 'https://marianditt.github.io/min-bend/'

;(async () => {
  const browser = await firefox.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errs = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push(String(e)))
  try {
    const resp = await page.goto(LIVE_URL, { waitUntil: 'load', timeout: 45000 })
    console.log('http status:', resp.status())
    await page.waitForSelector('h1.wiz__title', { timeout: 15000 })
    console.log('title:', (await page.textContent('h1.wiz__title')).trim())
    console.log('editor visible:', await page.isVisible('.pose-editor'))

    // Rules: a loop needs a fixed length, then solve.
    await page.getByRole('button', { name: /Next: Rules/ }).click()
    await page.getByRole('button', { name: 'Fixed length' }).click()
    await page.getByRole('button', { name: /Next: Sketch/ }).click()
    await page.getByRole('button', { name: /Review & solve/ }).click()
    await page.locator('.btn--lg').click()
    await page.waitForSelector('.wiz-banner.is-ok', { timeout: 90000 })
    const txt = (await page.textContent('.wiz-banner')).trim()
    console.log('banner:', txt)
    console.log('player visible:', await page.isVisible('.player'))

    const scale = await page.evaluate(() => Number(document.querySelector('canvas')?.dataset.scale || '-1'))
    console.log('canvas scale:', scale)
    console.log('console errors:', errs.filter((e) => !/favicon/i.test(e)).length)
    console.log(/settled/.test(txt) ? '\nLIVE SMOKE: PASS' : '\nLIVE SMOKE: FAIL')
  } catch (e) {
    console.log('LIVE SMOKE: FAIL —', e.message)
  } finally {
    await browser.close()
  }
})()
