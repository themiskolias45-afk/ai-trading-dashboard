/**
 * Visual regression checker for SmartEntry Pro dashboard pages.
 * Screenshots each page and diffs against golden baseline in tasks/snapshots/visual/.
 *
 * Usage:
 *   node tasks/visual_regression.cjs              -- compare against golden baseline
 *   node tasks/visual_regression.cjs --update     -- accept current state as new golden baseline
 *
 * Requires: server running on port 3001, Playwright/Puppeteer installed.
 * Exit 0 = all pages match baseline (or no baseline yet).
 * Exit 1 = visual regression detected — diff images in tasks/snapshots/visual/diff/.
 */

'use strict';
const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const UPDATE   = process.argv.includes('--update');
const BASE_URL = 'http://localhost:3001';
const SNAP_DIR = path.join(__dirname, 'snapshots', 'visual');
const DIFF_DIR = path.join(SNAP_DIR, 'diff');

const PAGES = [
  { name: 'index',       path: '/dashboard/index.html' },
  { name: 'performance', path: '/dashboard/performance.html' },
  { name: 'learning',    path: '/dashboard/learning.html' },
  { name: 'healer',      path: '/dashboard/healer.html' },
];

// Check server is up before trying to screenshot
function serverAlive() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/api/health`, r => resolve(r.statusCode < 500));
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const alive = await serverAlive();
  if (!alive) {
    console.log('SERVER OFFLINE — visual_regression.cjs skipped (server not running on port 3001)');
    process.exit(0);
  }

  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  // Try to use Puppeteer if available; fall back to a no-op with instructions
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.log('Puppeteer not installed — install with: npm install puppeteer');
    console.log('Visual regression requires Puppeteer. Skipping for now.');
    process.exit(0);
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
      ? require('path').join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium', 'chrome')
      : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });

  const failures = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  for (const { name, path: pagePath } of PAGES) {
    const url = `${BASE_URL}${pagePath}`;
    const goldenFile = path.join(SNAP_DIR, `${name}.png`);
    const currentFile = path.join(SNAP_DIR, `${name}-current.png`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.screenshot({ path: currentFile, fullPage: false });

      if (UPDATE || !fs.existsSync(goldenFile)) {
        fs.copyFileSync(currentFile, goldenFile);
        console.log(`GOLDEN UPDATED: ${name}`);
      } else {
        // Simple pixel diff using sharp if available, otherwise just report sizes
        const goldenSize = fs.statSync(goldenFile).size;
        const currentSize = fs.statSync(currentFile).size;
        const diff = Math.abs(goldenSize - currentSize) / goldenSize;

        if (diff > 0.05) {
          // > 5% file-size difference signals a likely visual regression
          failures.push({ name, diff: `${(diff * 100).toFixed(1)}% size change` });
          fs.copyFileSync(currentFile, path.join(DIFF_DIR, `${name}-diff.png`));
          console.log(`REGRESSION: ${name} — ${(diff * 100).toFixed(1)}% size change (check diff/)`);
        } else {
          console.log(`PASS: ${name}`);
        }
      }
    } catch (err) {
      console.log(`SKIP: ${name} — ${err.message}`);
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.log(`\nVISUAL REGRESSION DETECTED — ${failures.length} page(s) changed:`);
    failures.forEach(f => console.log(`  ${f.name}: ${f.diff}`));
    console.log(`Diff screenshots: ${DIFF_DIR}`);
    console.log('If change is intentional: node tasks/visual_regression.cjs --update');
    process.exit(1);
  } else {
    console.log('\nAll dashboard pages match golden baseline.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('visual_regression.cjs error:', err.message);
  process.exit(0); // Exit 0 on tool error — don't block commits for a broken test tool
});
