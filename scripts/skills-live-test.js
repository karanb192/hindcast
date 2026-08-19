// CDP suite for the Skills section in the Ledger: screenshots (dark, light,
// scoped-empty) plus row expansion and the click-through tape jump, against
// an app started with --remote-debugging-port=9315.
// Usage: node scripts/skills-live-test.js <outdir>
const { chromium } = require('playwright-core');

(async () => {
  const outDir = process.argv[2] || '.';
  const browser = await chromium.connectOverCDP('http://localhost:9315');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.setViewportSize({ width: 1440, height: 940 }).catch(() => {});
  await page.waitForTimeout(2500);

  const results = [];
  const assert = (c, msg) => results.push((c ? 'ok   ' : 'FAIL ') + msg);

  // Surface screenshots of an occluded window serve stale composited tiles
  // (observed as a half-dark half-light frame after a theme flip), so every
  // shot composites in the renderer instead.
  const cdp = await ctx.newCDPSession(page);
  const shoot = async (path) => {
    const shot = await cdp.send('Page.captureScreenshot', { fromSurface: false, format: 'png' });
    require('fs').writeFileSync(path, Buffer.from(shot.data, 'base64'));
  };

  // Open the Ledger and scroll the Skills section into view.
  await page.locator('.rail-item', { hasText: 'The Ledger' }).click();
  await page.waitForTimeout(600);
  const skillsSection = page.locator('.archive-section', { has: page.locator('h3', { hasText: 'Skills' }) });
  assert(await skillsSection.count() === 1, 'Skills section renders in the Ledger');
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.archive-section h3')].map((h) => h.textContent.trim().split('\n')[0]));
  assert(order.indexOf('Skills') === order.indexOf('Method') - 1,
    `section sits between Over time and Method (${order.join(' | ')})`);
  await skillsSection.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);

  const rowCount = await page.locator('.skills-table tbody tr').count();
  assert(rowCount > 0, `skills table has rows (${rowCount})`);
  assert(await page.locator('.skill-flag').count() >= 1, 'a never-fired or idle chip renders');
  assert(await page.locator('.skill-trend').first().locator('i').count() === 12,
    'trend has 12 fixed month slots');
  const method = await page.locator('.ledger-method').last().innerText();
  assert(method.includes('model filter'), 'Method note explains the model-filter exemption');

  // Theme shots. Wait out the theme effect AND assert the palette actually
  // flipped; a too-early screenshot once captured the old frame.
  await page.locator('.theme-seg button', { hasText: 'dark' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForTimeout(500);
  await shoot(`${outDir}/skills-dark.png`);

  await page.locator('.theme-seg button', { hasText: 'light' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.waitForTimeout(500);
  await shoot(`${outDir}/skills-light.png`);
  await page.locator('.theme-seg button', { hasText: 'dark' }).click();
  await page.waitForTimeout(400);

  // Expand the first fired row: the sessions list appears in place.
  const firstRow = page.locator('tr.skill-row').first();
  // The name is the text node between the twist glyph and any flag chips.
  const skillName = await firstRow.locator('td.name').evaluate((td) => {
    for (const n of td.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return n.textContent.trim();
    }
    return '';
  });
  await firstRow.click();
  await page.waitForTimeout(300);
  assert(await page.locator('tr.skill-detail').count() === 1, `row expands in place (${skillName})`);
  const lineCount = await page.locator('.skill-session').count();
  assert(lineCount > 0, `expansion lists sessions (${lineCount})`);
  await shoot(`${outDir}/skills-expanded.png`);

  // Single-expand: opening another row closes the first.
  const rows = page.locator('tr.skill-row');
  if (await rows.count() > 1) {
    await rows.nth(1).click();
    await page.waitForTimeout(300);
    assert(await page.locator('tr.skill-detail').count() === 1, 'single-expand: one detail row at a time');
    await rows.nth(1).click(); // collapse back
    await page.waitForTimeout(200);
    await rows.first().click();
    await page.waitForTimeout(200);
  }

  // Click-through: a session line opens the reel and the tape lands on the
  // invocation (a Skill tool card or the typed /command near mid-viewport).
  await page.locator('.skill-session').first().click();
  await page.waitForTimeout(3000);
  assert(await page.locator('.session-view').count() === 1, 'session opens from the expansion');
  const landed = await page.evaluate((id) => {
    const mid = window.innerHeight / 2;
    const near = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > mid - 200 && r.top < mid + 200;
    };
    for (const tag of document.querySelectorAll('.ev-tool .head .tag')) {
      if (tag.textContent === 'Skill' && near(tag)) return 'skill-tool';
    }
    for (const ev of document.querySelectorAll('.ev-user')) {
      if (ev.textContent.includes('/' + id) && near(ev)) return 'typed-command';
    }
    return null;
  }, skillName);
  assert(!!landed, `tape jump lands on the invocation (${landed || 'missed'})`);
  await shoot(`${outDir}/skills-jump.png`);

  // Scoped-empty state: a project with sessions but no skill usage renders
  // the quiet explainer paragraph instead of the table.
  // The Archive rail item is the scope reset; there is no All projects item.
  await page.locator('.rail-fixed .rail-item', { hasText: 'The Archive' }).click();
  await page.waitForTimeout(400);
  const emptyProject = await page.evaluate(async () => {
    const idx = await window.hindcast.getIndex();
    const used = new Set();
    for (const s of idx.sessions) if ((s.skills || []).length) used.add(s.project);
    const counts = {};
    for (const s of idx.sessions) counts[s.project] = (counts[s.project] || 0) + 1;
    const p = idx.projects.find((x) => !used.has(x.id) && counts[x.id] > 0);
    return p ? p.name : null;
  });
  if (emptyProject) {
    await page.locator('.rail-item .name', { hasText: emptyProject }).first().click();
    await page.waitForTimeout(400);
    await page.locator('.rail-item', { hasText: 'The Ledger' }).click();
    await page.waitForTimeout(600);
    const section = page.locator('.archive-section', { has: page.locator('h3', { hasText: 'Skills' }) });
    await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    // Installed-but-unfired rows still show in a scoped view (all-time
    // inventory), so the scoped state is either the explainer or a table
    // of blank rows with chips; both are designed, neither may crash.
    const para = await section.locator('.ledger-method').count();
    const blankRows = await section.locator('.skills-table tbody tr').count();
    assert(para === 1 || blankRows > 0, `scoped view stays designed (para=${para} rows=${blankRows})`);
    await shoot(`${outDir}/skills-empty-scope.png`);
  } else {
    results.push('skip scoped-empty: every project has skill usage');
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(failed ? `${failed} FAILED` : 'all green');
  process.exit(failed ? 1 : 0); // never browser.close(): that quits the app
})().catch((e) => { console.error('driver error: ' + e.message); process.exit(1); });
