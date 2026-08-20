// CDP suite for The Skills page: hero thesis, stats, table, screenshots
// (dark, light, scoped), row expansion, and the click-through tape jump,
// against an app started with --remote-debugging-port=9315. Also guards the
// Ledger regression: promotion must leave it a pure money page.
// Usage: node scripts/skills-live-test.js <outdir>
const { chromium } = require('playwright-core');

(async () => {
  const outDir = process.argv[2] || '.';
  const browser = await chromium.connectOverCDP('http://localhost:9315');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  // A minimized or fully hidden window stops producing frames and renderer
  // captures fail outright; claim the window before driving it.
  await page.bringToFront().catch(() => {});
  await page.setViewportSize({ width: 1440, height: 940 }).catch(() => {});
  await page.waitForTimeout(2500);

  const results = [];
  const assert = (c, msg) => results.push((c ? 'ok   ' : 'FAIL ') + msg);

  // Surface screenshots of an occluded window serve stale composited tiles
  // (observed as a half-dark half-light frame after a theme flip), so every
  // shot composites in the renderer instead.
  const cdp = await ctx.newCDPSession(page);
  const shoot = async (path) => {
    // Renderer-side capture refuses on a window parked on another Space;
    // fall back to the surface shot there (the window was brought to front
    // and theme flips are awaited, so stale tiles are not a risk by then).
    let data;
    try {
      ({ data } = await cdp.send('Page.captureScreenshot', { fromSurface: false, format: 'png' }));
    } catch {
      data = (await page.screenshot()).toString('base64');
    }
    require('fs').writeFileSync(path, Buffer.from(data, 'base64'));
  };

  // Start from the default view: a previous run (or the user) may have left
  // a project scope active, and every count below assumes the full archive.
  await page.locator('.rail-fixed .rail-item', { hasText: 'The Archive' }).click();
  await page.waitForTimeout(400);

  // The Ledger regression first: no skills content left behind.
  await page.locator('.rail-item', { hasText: 'The Ledger' }).click();
  await page.waitForTimeout(600);
  assert(await page.locator('.skills-table').count() === 0, 'Ledger carries no skills table');
  // h3s can nest controls (the day/week/month group), so read only the
  // heading's own text node.
  const ledgerOrder = await page.evaluate(() =>
    [...document.querySelectorAll('.archive-section h3')].map((h) => {
      for (const n of h.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) return n.textContent.trim();
      }
      return '';
    }));
  assert(ledgerOrder.join(' | ') === 'By model | Over time | Method',
    `Ledger is money only (${ledgerOrder.join(' | ')})`);

  // The Skills page.
  await page.locator('.rail-item', { hasText: 'The Skills' }).click();
  await page.waitForTimeout(600);
  assert((await page.locator('.archive-eyebrow').innerText()).trim() === 'THE SKILLS'
    || (await page.locator('.archive-eyebrow').innerText()).trim() === 'The Skills',
    'page opens under The Skills eyebrow');
  const thesis = (await page.locator('.archive-title').innerText()).trim();
  assert(/skills/i.test(thesis) && /\d/.test(thesis), `hero states the thesis (${thesis})`);
  assert(await page.locator('.stat-row .stat').count() === 6, 'stat row carries 6 stats');
  // The row must survive a reader's subtraction: installed = have fired +
  // never fired (the miscount that shipped first mixed removed skills into
  // the fired stat).
  const nums = await page.$$eval('.stat-row .stat .num', (els) => els.map((e) => Number(e.textContent)));
  assert(nums[0] === nums[1] + nums[2], `stat algebra closes (${nums[0]} = ${nums[1]} + ${nums[2]})`);
  const sub = await page.locator('.archive-sub').innerText();
  assert(sub.includes('model filter'), 'page sub explains the model-filter exemption');
  const bySkill = page.locator('.archive-section', { has: page.locator('h3', { hasText: 'By skill' }) });
  assert(await bySkill.count() === 1, 'By skill section renders');

  const rowCount = await page.locator('.skills-table tbody tr').count();
  assert(rowCount > 0, `skills table has rows (${rowCount})`);
  assert(await page.locator('.skill-flag').count() >= 1, 'a never-fired or idle chip renders');
  assert(await page.locator('.skill-flag', { hasText: 'bundled' }).count() >= 1,
    'bundled CLI skills wear the bundled chip, not "not installed"');
  assert(await page.locator('.skill-trend').first().locator('i').count() === 12,
    'trend has 12 fixed month slots');

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

  // Return path: a session opened from a skill row keeps the rail on The
  // Skills, and deselecting lands back on the page, not the Archive.
  const activeRail = (await page.locator('.rail-item.active .name').innerText()).trim();
  assert(activeRail === 'The Skills', `rail stays on The Skills over the open session (${activeRail})`);
  await page.locator('.rail-item', { hasText: 'The Skills' }).click();
  await page.waitForTimeout(400);
  assert((await page.locator('.archive-eyebrow').innerText()).trim().toLowerCase() === 'the skills',
    'closing the session returns to The Skills');

  // Scoped state: a project with sessions but no skill usage. The columns
  // empty out while the hero and flags stay archive-true.
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
    await page.locator('.rail-item', { hasText: 'The Skills' }).click();
    await page.waitForTimeout(600);
    const scopedThesis = (await page.locator('.archive-title').innerText()).trim();
    assert(scopedThesis === thesis, 'hero thesis stays archive-true under a project scope');
    // Installed-but-unfired rows still show in a scoped view (all-time
    // inventory), so the scoped state is either the explainer or a table
    // of blank rows with chips; both are designed, neither may crash.
    const para = await page.locator('.archive-section .ledger-method').count();
    const blankRows = await page.locator('.skills-table tbody tr').count();
    assert(para === 1 || blankRows > 0, `scoped view stays designed (para=${para} rows=${blankRows})`);
    await shoot(`${outDir}/skills-empty-scope.png`);
  } else {
    results.push('skip scoped-empty: every project has skill usage');
  }

  // Leave the app the way a person expects to find it: unscoped, on the
  // Archive.
  await page.locator('.rail-fixed .rail-item', { hasText: 'The Archive' }).click();
  await page.waitForTimeout(300);

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(failed ? `${failed} FAILED` : 'all green');
  process.exit(failed ? 1 : 0); // never browser.close(): that quits the app
})().catch((e) => { console.error('driver error: ' + e.message); process.exit(1); });
