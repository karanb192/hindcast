// Screenshot driver: connects to the running app over CDP.
// Usage: node scripts/shoot.js <outdir>
const { chromium } = require('playwright-core');

(async () => {
  const outDir = process.argv[2] || '.';
  const browser = await chromium.connectOverCDP('http://localhost:9315');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.setViewportSize({ width: 1440, height: 940 }).catch(() => {});
  await page.waitForTimeout(1500);

  // 1. Archive home
  await page.screenshot({ path: `${outDir}/1-archive.png` });

  // 2. Open a meaty session (first in list)
  const cards = page.locator('.session-card');
  if (await cards.count() > 0) {
    await cards.first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${outDir}/2-session.png` });

    // 3. Expand a tool card
    const tool = page.locator('.ev-tool .head').first();
    if (await tool.count() > 0) {
      await tool.click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${outDir}/3-tool-open.png` });
    }
  }

  // 4. Search overlay
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(400);
  await page.keyboard.type('power resides', { delay: 20 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/4-search.png` });
  await page.keyboard.press('Escape');

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });
