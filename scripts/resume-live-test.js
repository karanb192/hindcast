// Live checks for the resume-command feature (issue #10) against a running app:
//   npm start -- --remote-debugging-port=9315   (or the packaged app with the flag)
// Drives the real UI over CDP: chip presence, clipboard contents, template
// editing, persistence, per-session substitution, reset, and Escape-discard.
// The user's clipboard and settings.json are snapshotted and restored on exit;
// a settings.json the test itself created (fresh machine) is removed instead.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');

const pb = () => execSync('pbpaste').toString();
const settingsCandidates = ['Hindcast', 'hindcast', 'Electron']
  .map((n) => `${os.homedir()}/Library/Application Support/${n}/settings.json`);
const findSettings = () => settingsCandidates.find((p) => fs.existsSync(p));
const preExistingPath = findSettings();
const settingsBackup = preExistingPath ? fs.readFileSync(preExistingPath) : null;

(async () => {
  const userClipboard = pb();
  process.on('exit', () => {
    try { execSync('pbcopy', { input: userClipboard }); } catch {}
    try {
      if (preExistingPath) fs.writeFileSync(preExistingPath, settingsBackup);
      else { const p = findSettings(); if (p) fs.rmSync(p, { force: true }); }
    } catch {}
  });

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9315');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.session-card', { timeout: 30000 });
  await page.waitForTimeout(1500);

  let fails = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
    if (!cond) fails++;
  };
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const headerInfo = () => page.evaluate(() => {
    const chips = [...document.querySelectorAll('.sv-path .copy-chip')].map((c) => c.textContent);
    return { cwd: chips.length === 2 ? chips[0] : null, sid: chips[chips.length - 1] };
  });

  await (await page.$('.session-card')).click();
  await page.waitForSelector('.sv-path', { timeout: 15000 });
  await page.waitForTimeout(800);
  const info = await headerInfo();
  check('session header shows cwd + id', !!info.cwd && !!info.sid);

  // Normalize to the default template first: the machine running this may have
  // a real customized template (it is restored from the snapshot on exit).
  await (await page.waitForSelector('.sv-meta .reveal:has-text("✎")', { timeout: 5000 })).click();
  const input0 = await page.waitForSelector('.resume-edit input', { timeout: 5000 });
  await input0.fill('');
  await input0.press('Enter');
  await page.waitForTimeout(400);

  // 1. resume chip copies the default command, both values quoted
  const resume = await page.waitForSelector('.sv-meta .reveal:has-text("resume")', { timeout: 5000 });
  execSync('pbcopy', { input: 'sentinel' });
  await resume.click();
  await page.waitForTimeout(300);
  check('default command copied', pb() === `cd -- ${q(info.cwd)} && claude --resume ${q(info.sid)}`, pb());

  // 2. edit template to a custom alias, save with Enter (autoFocus makes Enter live)
  await (await page.waitForSelector('.sv-meta .reveal:has-text("✎")', { timeout: 5000 })).click();
  const input = await page.waitForSelector('.resume-edit input', { timeout: 5000 });
  check('editor shows current template', (await input.inputValue()) === 'cd -- {cwd} && claude --resume {sessionId}', await input.inputValue());
  check('editor input is focused on open', await page.evaluate(() => document.activeElement === document.querySelector('.resume-edit input')));
  await input.fill('cd {cwd} && ccr {sessionId}');
  await input.press('Enter');
  await page.waitForTimeout(400);
  check('editor closes on save', !(await page.$('.resume-edit')));
  await (await page.waitForSelector('.sv-meta .reveal:has-text("resume")', { timeout: 5000 })).click();
  await page.waitForTimeout(300);
  check('custom template used', pb() === `cd ${q(info.cwd)} && ccr ${q(info.sid)}`, pb());

  // 3. persists on disk (resolved after the save above, so a fresh machine
  // where the app never wrote settings.json before still finds the file)
  const settingsPath = findSettings();
  check('settings.json exists', !!settingsPath, String(settingsPath));
  if (settingsPath) {
    check('template persisted', JSON.parse(fs.readFileSync(settingsPath, 'utf8')).resumeTemplate === 'cd {cwd} && ccr {sessionId}');
  }

  // 4. another session substitutes its own cwd/id, and the editor does not follow
  const cards = await page.$$('.session-card');
  if (cards.length > 1) {
    await (await page.waitForSelector('.sv-meta .reveal:has-text("✎")', { timeout: 5000 })).click();
    await page.waitForSelector('.resume-edit input', { timeout: 5000 });
    await cards[1].click();
    await page.waitForTimeout(1000);
    check('open editor does not follow a session switch', !(await page.$('.resume-edit')));
    const i2 = await headerInfo();
    if (i2.cwd) {
      await (await page.waitForSelector('.sv-meta .reveal:has-text("resume")', { timeout: 5000 })).click();
      await page.waitForTimeout(300);
      check('other session substitutes its own cwd/id', pb() === `cd ${q(i2.cwd)} && ccr ${q(i2.sid)}`, pb());
    }
  }

  // 5. reset fills the default into the editor; save stores it as absent
  await (await page.waitForSelector('.sv-meta .reveal:has-text("✎")', { timeout: 5000 })).click();
  const input2 = await page.waitForSelector('.resume-edit input', { timeout: 5000 });
  await (await page.waitForSelector('.resume-edit .reveal:has-text("reset")', { timeout: 5000 })).click();
  check('reset fills default into editor', (await input2.inputValue()) === 'cd -- {cwd} && claude --resume {sessionId}');
  await (await page.waitForSelector('.resume-edit .reveal:has-text("save")', { timeout: 5000 })).click();
  await page.waitForTimeout(400);
  if (settingsPath) {
    check('default stored as absent key', !('resumeTemplate' in JSON.parse(fs.readFileSync(settingsPath, 'utf8'))));
  }

  // 6. Escape closes the editor without saving
  await (await page.waitForSelector('.sv-meta .reveal:has-text("✎")', { timeout: 5000 })).click();
  const input3 = await page.waitForSelector('.resume-edit input', { timeout: 5000 });
  await input3.fill('garbage {cwd}');
  await input3.press('Escape');
  await page.waitForTimeout(300);
  check('escape closes without saving', !(await page.$('.resume-edit')));
  await (await page.waitForSelector('.sv-meta .reveal:has-text("resume")', { timeout: 5000 })).click();
  await page.waitForTimeout(300);
  check('discarded draft not applied', pb().includes('claude --resume'), pb());

  console.log(fails ? `\n${fails} FAILURES` : '\nall green');
  process.exit(fails ? 1 : 0); // process.exit, not browser.close(): closing a CDP connection quits the app
})().catch((e) => { console.error('DRIVER ERROR', e.message); process.exit(2); });
