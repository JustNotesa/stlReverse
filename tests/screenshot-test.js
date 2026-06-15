/**
 * Screenshot-Test: Macht Screenshots vom Add-on UI
 * und testet die Kernfunktionalität visuell
 */

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');
const SAMPLE_STL = join(ADDON_PATH, 'samples/cube_ascii.stl');
const SCREENSHOT_DIR = join(__dirname, 'screenshots');

// Screenshot-Ordner erstellen
if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function takeScreenshots() {
  console.log('Starte Browser...');

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
      defaultViewport: { width: 800, height: 600 }
    });

    const page = await browser.newPage();
    const popupUrl = `file://${ADDON_PATH}/popup.html`;

    try {
    // 1. Leerer Zustand (Initial)
    console.log('1. Screenshot: Leerer Zustand...');
    await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('#drop-zone');
    await page.screenshot({
      path: join(SCREENSHOT_DIR, '01-initial-empty.png'),
      fullPage: true
    });
    console.log('   -> 01-initial-empty.png gespeichert');

    // 2. STL-Datei hochladen
    console.log('2. Screenshot: Nach STL-Upload...');
    const fileInput = await page.$('#file-input');

    if (fileInput && existsSync(SAMPLE_STL)) {
      await fileInput.uploadFile(SAMPLE_STL);

      // Warten auf Verarbeitung
      console.log('   Warte auf Analyse...');
      await page.waitForFunction(() => {
        const output = document.getElementById('param-output');
        return output && output.value && output.value.length > 10;
      }, { timeout: 60000 });

      // Kurz warten für Rendering
      await new Promise(r => setTimeout(r, 1000));

      await page.screenshot({
        path: join(SCREENSHOT_DIR, '02-after-upload.png'),
        fullPage: true
      });
      console.log('   -> 02-after-upload.png gespeichert');

      // 3. JSON-Output extrahieren
      const jsonOutput = await page.$eval('#param-output', el => el.value);
      console.log('\n--- Analyse-Ergebnis (JSON) ---');
      try {
        const parsed = JSON.parse(jsonOutput);
        console.log('Meta:', parsed.meta);
        console.log('BoundingBox:', parsed.boundingBox);
        console.log('Planes:', parsed.planes?.length || 0, 'Flächen');
        console.log('Cylinders:', parsed.cylinders?.length || 0);
        console.log('Cones:', parsed.cones?.length || 0);
        console.log('Spheres:', parsed.spheres?.length || 0);
      } catch (e) {
        console.log('JSON Parse Error:', e.message);
      }

      // 4. Screenshot der Stats
      console.log('\n3. Screenshot: Stats-Bereich...');
      const statsElement = await page.$('.stats-grid');
      if (statsElement) {
        await statsElement.screenshot({
          path: join(SCREENSHOT_DIR, '03-stats.png')
        });
        console.log('   -> 03-stats.png gespeichert');
      }

      // 5. Screenshot der Canvas-Projektionen
      console.log('4. Screenshot: Canvas-Projektionen...');
      const canvasXY = await page.$('#canvas-xy');
      const canvasYZ = await page.$('#canvas-yz');
      const canvasZX = await page.$('#canvas-zx');
      const canvas3D = await page.$('#canvas-3d');

      if (canvasXY) {
        await canvasXY.screenshot({ path: join(SCREENSHOT_DIR, '04-canvas-xy.png') });
        console.log('   -> 04-canvas-xy.png gespeichert');
      }
      if (canvasYZ) {
        await canvasYZ.screenshot({ path: join(SCREENSHOT_DIR, '05-canvas-yz.png') });
        console.log('   -> 05-canvas-yz.png gespeichert');
      }
      if (canvasZX) {
        await canvasZX.screenshot({ path: join(SCREENSHOT_DIR, '06-canvas-zx.png') });
        console.log('   -> 06-canvas-zx.png gespeichert');
      }
      if (canvas3D) {
        await canvas3D.screenshot({ path: join(SCREENSHOT_DIR, '07-canvas-3d.png') });
        console.log('   -> 07-canvas-3d.png gespeichert');
      }

    } else {
      console.log('   FEHLER: Kein File-Input oder Sample-STL nicht gefunden');
    }

    } catch (error) {
      console.error('Fehler:', error.message);
      await page.screenshot({
        path: join(SCREENSHOT_DIR, 'error-state.png'),
        fullPage: true
      });
    }

    console.log('\n--- Fertig ---');
    console.log(`Screenshots gespeichert in: ${SCREENSHOT_DIR}`);

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

takeScreenshots();
