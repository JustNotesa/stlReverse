/**
 * Test: STEP-Export für alle Sample-STLs generieren
 */

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { startLocalServer, closeBrowser } from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');
const SAMPLES_DIR = join(ADDON_PATH, 'samples');
const OUTPUT_DIR = join(__dirname, 'step-exports');

if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function exportStepFiles() {
  const stlFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.stl'));

  console.log('STEP-Export Test');
  console.log(`Gefundene STL-Dateien: ${stlFiles.length}`);

  // Lokaler HTTP-Server (Web Worker braucht HTTP, nicht file://)
  const localServer = await startLocalServer();
  console.log(`HTTP-Server: ${localServer.url}`);

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--use-gl=swiftshader',
        '--ignore-gpu-blocklist'
      ],
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    const popupUrl = `${localServer.url}/popup.html`;

    // Console-Logs abfangen
    page.on('console', msg => {
      if (msg.text().includes('B-Rep') || msg.type() === 'error') {
        console.log('  [Browser]', msg.text());
      }
    });

    for (const stlFile of stlFiles) {
    const stlPath = join(SAMPLES_DIR, stlFile);
    const baseName = stlFile.replace('.stl', '');

    console.log(`\n=== ${stlFile} ===`);

    try {
      await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });

      // STL hochladen
      const fileInput = await page.$('#file-input');
      await fileInput.uploadFile(stlPath);

      // Warten auf Analyse
      await page.waitForFunction(() => {
        const output = document.getElementById('param-output');
        return output && output.value && output.value.length > 10;
      }, { timeout: 90000 });

      await new Promise(r => setTimeout(r, 500));

      // Analyse-Ergebnis extrahieren
      const analysis = await page.evaluate(() => {
        const output = document.getElementById('param-output');
        return JSON.parse(output.value);
      });

      console.log(`  Triangles: ${analysis.meta?.triangles}`);
      console.log(`  Planes: ${analysis.planes?.length || 0}`);
      console.log(`  Cylinders: ${analysis.cylinders?.length || 0}`);
      console.log(`  Cones: ${analysis.cones?.length || 0}`);
      console.log(`  Spheres: ${analysis.spheres?.length || 0}`);

      // STEP-Export triggern und Inhalt abfangen
      const stepContent = await page.evaluate(() => {
        // Finde die buildVolumeStepBrep Funktion und rufe sie auf
        const output = document.getElementById('param-output');
        const analysis = JSON.parse(output.value);

        // Simuliere Klick auf Download-Button und fange den Inhalt ab
        return new Promise((resolve) => {
          const originalCreateObjectURL = URL.createObjectURL;
          URL.createObjectURL = (blob) => {
            blob.text().then(text => resolve(text));
            return originalCreateObjectURL(blob);
          };

          const downloadBtn = document.getElementById('download-step-solid');
          if (downloadBtn) {
            downloadBtn.click();
          } else {
            resolve(null);
          }

          // Timeout falls kein Download
          setTimeout(() => resolve(null), 2000);
        });
      });

      if (stepContent) {
        const stepPath = join(OUTPUT_DIR, `${baseName}.step`);
        writeFileSync(stepPath, stepContent);
        console.log(`  -> STEP exportiert: ${baseName}.step`);

        // Einfache STEP-Validierung
        const entityCount = (stepContent.match(/^#\d+=/gm) || []).length;
        const hasSolid = stepContent.includes('MANIFOLD_SOLID_BREP');
        const hasCylinder = stepContent.includes('CYLINDRICAL_SURFACE');
        const hasCone = stepContent.includes('CONICAL_SURFACE');
        const hasSphere = stepContent.includes('SPHERICAL_SURFACE');

        console.log(`  STEP-Entities: ${entityCount}`);
        console.log(`  Hat Solid: ${hasSolid ? 'JA' : 'NEIN'}`);
        console.log(`  Hat Zylinder: ${hasCylinder ? 'JA' : 'NEIN'}`);
        console.log(`  Hat Kegel: ${hasCone ? 'JA' : 'NEIN'}`);
        console.log(`  Hat Kugel: ${hasSphere ? 'JA' : 'NEIN'}`);
      } else {
        console.log('  FEHLER: Kein STEP-Export möglich');
      }

    } catch (error) {
      console.error(`  FEHLER: ${error.message}`);
    }
  }

    console.log(`\n=== FERTIG ===`);
    console.log(`STEP-Dateien in: ${OUTPUT_DIR}`);

  } finally {
    await closeBrowser(browser);
    await localServer.close();
  }
}

exportStepFiles();
