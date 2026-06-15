/**
 * Vergleich: Live 3D Ansicht vs STEP Webviewer
 */

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');
const SAMPLE_STL = join(ADDON_PATH, 'samples/cylinder.stl');
const OUTPUT_DIR = join(__dirname, 'screenshots/viewer-comparison');

if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function compareViewers() {
  console.log('Viewer-Vergleich: Live 3D vs STEP Webviewer\n');

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--allow-file-access-from-files',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      defaultViewport: { width: 1600, height: 1200, deviceScaleFactor: 2 }
    });

    const page = await browser.newPage();
    const popupUrl = `file://${ADDON_PATH}/popup.html`;

  await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // STL hochladen
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(SAMPLE_STL);

  // Warten auf Analyse
  await page.waitForFunction(() => {
    const output = document.getElementById('param-output');
    return output && output.value && output.value.length > 10;
  }, { timeout: 60000 });

  await new Promise(r => setTimeout(r, 2000)); // Extra Zeit für WebGL

  // 1. Live 3D Ansicht
  console.log('1. Live 3D Ansicht (canvas-3d):');
  const canvas3d = await page.$('#canvas-3d');
  if (canvas3d) {
    await canvas3d.screenshot({ path: join(OUTPUT_DIR, 'live-3d.png') });
    const info = await page.evaluate(() => {
      const canvas = document.getElementById('canvas-3d');
      const label = document.getElementById('preview-mode-label');
      return {
        width: canvas?.width,
        height: canvas?.height,
        mode: label?.textContent
      };
    });
    console.log(`   Größe: ${info.width}x${info.height}`);
    console.log(`   Modus: ${info.mode}`);
    console.log('   -> live-3d.png gespeichert');
  }

  // 2. STEP Webviewer
  console.log('\n2. STEP Webviewer (step-viewer):');
  const stepViewer = await page.$('#step-viewer');
  if (stepViewer) {
    await stepViewer.screenshot({ path: join(OUTPUT_DIR, 'step-viewer.png') });
    const info = await page.evaluate(() => {
      const viewer = document.getElementById('step-viewer');
      return {
        state: viewer?.dataset?.state,
        width: viewer?.clientWidth,
        height: viewer?.clientHeight,
        hasCanvas: !!viewer?.querySelector('canvas')
      };
    });
    console.log(`   Größe: ${info.width}x${info.height}`);
    console.log(`   State: ${info.state}`);
    console.log(`   Hat Canvas: ${info.hasCanvas ? 'JA' : 'NEIN'}`);
    console.log('   -> step-viewer.png gespeichert');
  }

  // 3. Modus wechseln (falls möglich)
  console.log('\n3. Modus wechseln...');
  const toggleBtn = await page.$('#preview-mode-toggle');
  if (toggleBtn) {
    const isDisabled = await page.evaluate(el => el.disabled, toggleBtn);
    console.log(`   Toggle-Button disabled: ${isDisabled}`);

    if (!isDisabled) {
      await toggleBtn.click();
      await new Promise(r => setTimeout(r, 500));

      await canvas3d.screenshot({ path: join(OUTPUT_DIR, 'live-3d-volume.png') });
      const newMode = await page.evaluate(() => {
        return document.getElementById('preview-mode-label')?.textContent;
      });
      console.log(`   Neuer Modus: ${newMode}`);
      console.log('   -> live-3d-volume.png gespeichert');
    }
  }

    // 4. Gesamtansicht
    console.log('\n4. Gesamtansicht...');
    await page.screenshot({ path: join(OUTPUT_DIR, 'full-page.png'), fullPage: true });
    console.log('   -> full-page.png gespeichert');

    console.log(`\nScreenshots in: ${OUTPUT_DIR}`);

  } catch (error) {
    console.error('FEHLER:', error.message);
  } finally {
    // Browser IMMER schließen, auch bei Fehlern
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.warn('Browser-Close fehlgeschlagen, force kill...');
        try {
          browser.process()?.kill('SIGKILL');
        } catch (e) { /* ignore */ }
      }
    }
  }
}

compareViewers();
