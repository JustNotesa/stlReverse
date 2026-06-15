/**
 * Visueller Regressionstest
 * Testet alle Sample-STLs und vergleicht Ergebnisse
 */

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');
const SAMPLES_DIR = join(ADDON_PATH, 'samples');
const SCREENSHOT_DIR = join(__dirname, 'screenshots');
const RESULTS_FILE = join(__dirname, 'test-results.json');

if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function testAllSamples() {
  const results = [];
  const stlFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.stl'));

  console.log(`Gefundene STL-Dateien: ${stlFiles.length}`);
  console.log(stlFiles.map(f => `  - ${f}`).join('\n'));
  console.log('');

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
      defaultViewport: { width: 900, height: 700 }
    });

    const page = await browser.newPage();
    const popupUrl = `file://${ADDON_PATH}/popup.html`;

    for (const stlFile of stlFiles) {
    const stlPath = join(SAMPLES_DIR, stlFile);
    const baseName = stlFile.replace('.stl', '');

    console.log(`\n=== Teste: ${stlFile} ===`);

    try {
      // Seite neu laden für sauberen Zustand
      await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });

      // STL hochladen
      const fileInput = await page.$('#file-input');
      await fileInput.uploadFile(stlPath);

      // Warten auf Analyse
      console.log('  Warte auf Analyse...');
      await page.waitForFunction(() => {
        const output = document.getElementById('param-output');
        return output && output.value && output.value.length > 10;
      }, { timeout: 60000 });

      await new Promise(r => setTimeout(r, 500));

      // Screenshot
      await page.screenshot({
        path: join(SCREENSHOT_DIR, `${baseName}-full.png`),
        fullPage: true
      });

      // JSON-Ergebnis extrahieren
      const jsonOutput = await page.$eval('#param-output', el => el.value);
      const analysis = JSON.parse(jsonOutput);

      // Ergebnis speichern
      const result = {
        file: stlFile,
        success: true,
        meta: analysis.meta,
        boundingBox: analysis.boundingBox,
        features: {
          planes: analysis.planes?.length || 0,
          cylinders: analysis.cylinders?.length || 0,
          cones: analysis.cones?.length || 0,
          spheres: analysis.spheres?.length || 0
        },
        screenshot: `${baseName}-full.png`
      };

      results.push(result);

      console.log(`  Triangles: ${analysis.meta.triangles}`);
      console.log(`  BBox: ${analysis.boundingBox.width} x ${analysis.boundingBox.depth} x ${analysis.boundingBox.height}`);
      console.log(`  Planes: ${result.features.planes}`);
      console.log(`  Cylinders: ${result.features.cylinders}`);
      console.log(`  Cones: ${result.features.cones}`);
      console.log(`  Spheres: ${result.features.spheres}`);
      console.log(`  -> Screenshot: ${baseName}-full.png`);

    } catch (error) {
      console.error(`  FEHLER: ${error.message}`);
      results.push({
        file: stlFile,
        success: false,
        error: error.message
      });

      await page.screenshot({
        path: join(SCREENSHOT_DIR, `${baseName}-error.png`),
        fullPage: true
      });
    }
  }

    // Ergebnisse speichern
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    console.log(`\n\n=== ZUSAMMENFASSUNG ===`);
    console.log(`Getestet: ${results.length} Dateien`);
    console.log(`Erfolgreich: ${results.filter(r => r.success).length}`);
    console.log(`Fehlgeschlagen: ${results.filter(r => !r.success).length}`);
    console.log(`\nErgebnisse gespeichert: ${RESULTS_FILE}`);

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

  return results;
}

testAllSamples();
