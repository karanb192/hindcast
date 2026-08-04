// Verify tape click-to-seek lands the chosen event at the top of the transcript.
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9315');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.session-card', { timeout: 20000 });

  // Click through sessions until one with a long transcript is open.
  const stableCount = async () => {
    let prev = -1;
    for (let t = 0; t < 20; t++) {
      const n = await page.evaluate(() => document.querySelectorAll('[id^="ev-"]').length);
      if (n > 0 && n === prev) return n;
      prev = n;
      await page.waitForTimeout(300);
    }
    return prev;
  };
  const items = await page.$$('.session-card');
  let nEvents = 0;
  for (let i = 0; i < Math.min(items.length, 15); i++) {
    await items[i].click();
    const n = await stableCount();
    if (n > 150) { console.log(`session ${i}: ${n} events — using it`); nEvents = n; break; }
  }
  if (!nEvents) { nEvents = await stableCount(); console.log(`fallback session (${nEvents} events)`); }

  const tape = await page.waitForSelector('.tape', { timeout: 5000 });
  const box = await tape.boundingBox();

  // The playhead draws at (index at reference line) / (n-1). Verify that after
  // a click at fraction f, that index equals round(f*(n-1)) — i.e. the cursor
  // lands under the click — and the target event is on screen.
  const probe = (idx) => page.evaluate((expected) => {
    const boxEl = document.querySelector('.transcript');
    const n = document.querySelectorAll('[id^="ev-"]').length;
    const max = boxEl.scrollHeight - boxEl.clientHeight;
    const b = boxEl.getBoundingClientRect();
    const refY = b.top + (max > 0 ? boxEl.scrollTop / max : 0) * boxEl.clientHeight;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const el = document.getElementById('ev-' + mid);
      if (el && el.getBoundingClientRect().top <= refY) lo = mid; else hi = mid - 1;
    }
    const t = document.getElementById('ev-' + expected).getBoundingClientRect();
    return { refIdx: lo, visible: t.bottom > b.top && t.top < b.bottom };
  }, idx);

  let pass = 0, fail = 0;
  for (const frac of [0.15, 0.4, 0.6, 0.85, 0.3, 0.95, 0.05, 0.7]) {
    const x = box.x + 2 + frac * (box.width - 4);
    await page.mouse.click(x, box.y + box.height / 2);
    await page.waitForTimeout(700); // let the settle loop finish
    const expected = Math.round(frac * (nEvents - 1));
    const res = await probe(expected);
    const ok = res && Math.abs(res.refIdx - expected) <= 1 && res.visible;
    console.log(`click frac ${frac} -> ev-${expected}: playhead at ev-${res.refIdx} visible=${res.visible} ${ok ? 'OK' : 'FAIL'}`);
    ok ? pass++ : fail++;
  }

  // Drag sweep: press at 0.2, drag to 0.8 in steps; playhead index should
  // track the cursor index closely at every step (no jumping).
  const yMid = box.y + box.height / 2;
  await page.mouse.move(box.x + 2 + 0.2 * (box.width - 4), yMid);
  await page.mouse.down();
  for (let f = 0.2; f <= 0.8001; f += 0.1) {
    await page.mouse.move(box.x + 2 + f * (box.width - 4), yMid, { steps: 3 });
    await page.waitForTimeout(350);
    const expected = Math.round(f * (nEvents - 1));
    const res = await probe(expected);
    const drift = Math.abs(res.refIdx - expected);
    const ok = drift <= Math.max(2, Math.round(nEvents * 0.02));
    console.log(`drag frac ${f.toFixed(1)} -> ev-${expected}: playhead at ev-${res.refIdx} (drift ${drift}) ${ok ? 'OK' : 'FAIL'}`);
    ok ? pass++ : fail++;
  }
  await page.mouse.up();

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
