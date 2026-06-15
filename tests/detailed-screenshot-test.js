/**
 * Detaillierte Screenshot-Tests für einzelne Viewer-Komponenten
 * Erstellt hochauflösende Screenshots der einzelnen Bereiche
 */

import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { startLocalServer, closeBrowser } from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');
const SAMPLES_DIR = join(ADDON_PATH, 'samples');
const SCREENSHOT_DIR = join(__dirname, 'screenshots/detailed');

if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function captureDetailedScreenshots(stlFile, serverUrl) {
  const baseName = stlFile.replace('.stl', '');
  const stlPath = join(SAMPLES_DIR, stlFile);
  const outputDir = join(SCREENSHOT_DIR, baseName);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  console.log(`\n=== Detaillierte Screenshots: ${stlFile} ===`);

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
      defaultViewport: { width: 1600, height: 1200, deviceScaleFactor: 2 }
    });

    const page = await browser.newPage();

    // Browser-Konsole mitloggen
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('  [Browser Error]', msg.text());
    });

    // HTTP-Server verwenden (statt file://) damit Web Worker ES-Module laden können
    const popupUrl = `${serverUrl}/popup.html`;
    await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // STL hochladen
    const fileInput = await page.$('#file-input');
    await fileInput.uploadFile(stlPath);

    // Warten auf Analyse
    console.log('  Warte auf Analyse...');
    await page.waitForFunction(() => {
      const output = document.getElementById('param-output');
      return output && output.value && output.value.length > 10;
    }, { timeout: 90000 });

    await new Promise(r => setTimeout(r, 1500)); // Extra Zeit für Rendering

    // 1. Orthoprojektionen einzeln
    console.log('  1. Orthoprojektionen...');

    const canvasXY = await page.$('#canvas-xy');
    if (canvasXY) {
      await canvasXY.screenshot({ path: join(outputDir, '01-ortho-XY.png') });
      console.log('     -> 01-ortho-XY.png');
    }

    const canvasYZ = await page.$('#canvas-yz');
    if (canvasYZ) {
      await canvasYZ.screenshot({ path: join(outputDir, '02-ortho-YZ.png') });
      console.log('     -> 02-ortho-YZ.png');
    }

    const canvasZX = await page.$('#canvas-zx');
    if (canvasZX) {
      await canvasZX.screenshot({ path: join(outputDir, '03-ortho-ZX.png') });
      console.log('     -> 03-ortho-ZX.png');
    }

    // 2. Pipeline-Viewer: Original STL Mesh
    console.log('  2. Pipeline Viewer 1: Original STL...');
    const stlViewer = await page.$('#stl-viewer');
    if (stlViewer) {
      await stlViewer.screenshot({ path: join(outputDir, '04-stl-viewer.png') });
      console.log('     -> 04-stl-viewer.png');
    }

    // 3. Pipeline-Viewer: Erkannte Features
    console.log('  3. Pipeline Viewer 2: Erkannte Features...');
    const featuresViewer = await page.$('#features-viewer');
    if (featuresViewer) {
      await featuresViewer.screenshot({ path: join(outputDir, '05-features-viewer.png') });
      console.log('     -> 05-features-viewer.png');
    }

    // 4. Pipeline-Viewer: B-Rep Rekonstruktion
    console.log('  4. Pipeline Viewer 3: B-Rep...');
    const brepViewer = await page.$('#brep-viewer');
    if (brepViewer) {
      await brepViewer.screenshot({ path: join(outputDir, '06-brep-viewer.png') });
      console.log('     -> 06-brep-viewer.png');
    }

    // 5. Feature-Tabellen
    console.log('  5. Feature-Tabellen...');

    const planeTable = await page.$('#plane-table');
    if (planeTable) {
      const box = await planeTable.boundingBox();
      if (box && box.height > 20) {
        await planeTable.screenshot({ path: join(outputDir, '07-planes-table.png') });
        console.log('     -> 07-planes-table.png');
      }
    }

    const cylinderTable = await page.$('#cylinder-table');
    if (cylinderTable) {
      const box = await cylinderTable.boundingBox();
      if (box && box.height > 20) {
        await cylinderTable.screenshot({ path: join(outputDir, '08-cylinders-table.png') });
        console.log('     -> 08-cylinders-table.png');
      }
    }

    const sphereTable = await page.$('#sphere-table');
    if (sphereTable) {
      const box = await sphereTable.boundingBox();
      if (box && box.height > 20) {
        await sphereTable.screenshot({ path: join(outputDir, '09-spheres-table.png') });
        console.log('     -> 09-spheres-table.png');
      }
    }

    // 6. Geometrie-Stats
    console.log('  6. Geometrie-Stats...');
    const statsGrid = await page.$('.stats-grid');
    if (statsGrid) {
      await statsGrid.screenshot({ path: join(outputDir, '10-geometry-stats.png') });
      console.log('     -> 10-geometry-stats.png');
    }

    // 7. Canvas-Analyse
    console.log('  7. Canvas-Daten extrahieren...');
    const canvasData = await page.evaluate(() => {
      const result = {};
      const checkCanvas = (id) => {
        const c = document.getElementById(id);
        if (!c) return null;
        try {
          const ctx = c.getContext('2d');
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const nonEmpty = Array.from(img.data).filter((v, i) => i % 4 === 3 && v > 0).length;
          return { width: c.width, height: c.height, nonEmptyPixels: nonEmpty, hasContent: nonEmpty > 100 };
        } catch (e) { return { width: c.width, height: c.height, nonEmptyPixels: 0, hasContent: false }; }
      };
      result.xy = checkCanvas('canvas-xy');
      result.yz = checkCanvas('canvas-yz');
      result.zx = checkCanvas('canvas-zx');
      result.pipelineViewers = {
        stl: document.getElementById('stl-viewer')?.dataset?.state || 'not found',
        features: document.getElementById('features-viewer')?.dataset?.state || 'not found',
        brep: document.getElementById('brep-viewer')?.dataset?.state || 'not found'
      };
      return result;
    });

    console.log('\n  Canvas-Analyse:');
    console.log(`     XY: ${canvasData.xy?.width}x${canvasData.xy?.height}, Inhalt: ${canvasData.xy?.hasContent ? 'JA' : 'NEIN'} (${canvasData.xy?.nonEmptyPixels} Pixel)`);
    console.log(`     YZ: ${canvasData.yz?.width}x${canvasData.yz?.height}, Inhalt: ${canvasData.yz?.hasContent ? 'JA' : 'NEIN'} (${canvasData.yz?.nonEmptyPixels} Pixel)`);
    console.log(`     ZX: ${canvasData.zx?.width}x${canvasData.zx?.height}, Inhalt: ${canvasData.zx?.hasContent ? 'JA' : 'NEIN'} (${canvasData.zx?.nonEmptyPixels} Pixel)`);
    console.log('  Pipeline-Viewer:');
    console.log(`     STL Viewer: ${canvasData.pipelineViewers?.stl}`);
    console.log(`     Features Viewer: ${canvasData.pipelineViewers?.features}`);
    console.log(`     B-Rep Viewer: ${canvasData.pipelineViewers?.brep}`);
    console.log(`\n  Screenshots gespeichert in: ${outputDir}`);

  } catch (error) {
    console.error(`  FEHLER: ${error.message}`);
  } finally {
    await closeBrowser(browser);
  }
}

async function main() {
  const stlFiles = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.stl'));

  console.log('Detaillierte Screenshot-Tests');
  console.log(`Gefundene STL-Dateien: ${stlFiles.length}`);

  // Lokalen HTTP-Server starten
  const localServer = await startLocalServer();
  console.log(`HTTP-Server läuft auf: ${localServer.url}`);

  try {
    for (const stlFile of stlFiles) {
      await captureDetailedScreenshots(stlFile, localServer.url);
    }
  } finally {
    await localServer.close();
  }

  console.log('\n=== FERTIG ===');
}

main();
