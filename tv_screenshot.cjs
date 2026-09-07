'use strict';
/**
 * JARVIS TradingView Screenshot Tool
 * Captures BTC, GOLD, and SPX charts at Daily and 4H timeframes.
 * Saves PNGs to dashboard/screenshots/ for the daily plan page.
 *
 * Usage:
 *   node tv_screenshot.cjs              # all 3 assets, Daily timeframe
 *   node tv_screenshot.cjs --4h         # Daily + 4H for all assets
 *   node tv_screenshot.cjs --symbol BTC # single symbol
 *
 * Requirements:
 *   npm install puppeteer-core          (in project root, not server/)
 *   Edge must be installed at default path
 */

const path = require('path');
const fs   = require('fs');

const ROOT      = __dirname;
const OUT_DIR   = path.join(ROOT, 'dashboard', 'screenshots');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const USER_DATA = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\Edge\\SmartEntryTV';

const SYMBOLS = {
  btc:  { url: 'https://www.tradingview.com/chart/?symbol=BTCUSDT',  label: 'BTC' },
  gold: { url: 'https://www.tradingview.com/chart/?symbol=XAUUSD',   label: 'GOLD' },
  spx:  { url: 'https://www.tradingview.com/chart/?symbol=SPX',      label: 'SPX' },
};

const TIMEFRAME_KEYS = {
  'D': '1D',
  '4h': '4H',
};

async function run() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (_) {
    console.error('[tv_screenshot] puppeteer-core not installed.');
    console.error('  Run: npm install puppeteer-core  (in project root)');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const argv        = process.argv.slice(2);
  const do4h        = argv.includes('--4h');
  const symbolArg   = argv.includes('--symbol') ? argv[argv.indexOf('--symbol') + 1]?.toLowerCase() : null;
  const targets     = symbolArg ? { [symbolArg]: SYMBOLS[symbolArg] } : SYMBOLS;

  if (symbolArg && !SYMBOLS[symbolArg]) {
    console.error(`[tv_screenshot] Unknown symbol: ${symbolArg}. Use btc, gold, or spx.`);
    process.exit(1);
  }

  console.log('[tv_screenshot] Launching Edge…');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    userDataDir:    USER_DATA,
    headless:       true,
    args:           ['--no-first-run', '--start-maximized'],
  });

  try {
    for (const [key, { url, label }] of Object.entries(targets)) {
      const timeframes = do4h ? ['D', '4h'] : ['D'];

      for (const tf of timeframes) {
        const tfLabel = TIMEFRAME_KEYS[tf] || tf;
        const outFile = path.join(OUT_DIR, `${key}_${tf.toLowerCase()}.png`);

        console.log(`[tv_screenshot] Capturing ${label} ${tfLabel}…`);
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 900 });

        // Navigate with timeframe in URL
        const chartUrl = `${url}&interval=${tf}`;
        await page.goto(chartUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for the chart canvas to appear
        await page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});
        // Extra settle time for chart to render data
        await new Promise(r => setTimeout(r, 4000));

        // Hide header/toolbar for cleaner screenshot
        await page.evaluate(() => {
          const selectors = [
            '.tv-header', '#header-toolbar-widget-bar',
            '.widgetbar-widget', '.tv-side-toolbar',
          ];
          selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
          });
        }).catch(() => {});

        await page.screenshot({ path: outFile, type: 'png' });
        await page.close();
        console.log(`[tv_screenshot] ✓ Saved: ${path.basename(outFile)}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[tv_screenshot] Done — screenshots in ${OUT_DIR}`);
}

run().catch(err => {
  console.error('[tv_screenshot] Fatal:', err.message);
  process.exit(1);
});
