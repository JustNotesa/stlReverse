/**
 * Debug: Feature-Erkennung fuer block_with_hole analysieren
 */
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');

(async () => {
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
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
  await page.goto(`file://${ADDON_PATH}/popup.html`, { waitUntil: 'networkidle0', timeout: 30000 });

  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(join(ADDON_PATH, 'samples', 'block_with_hole.stl'));

  await page.waitForFunction(() => {
    const output = document.getElementById('param-output');
    return output && output.value && output.value.length > 10;
  }, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 1000));

  // Lese param-output (JSON)
  const parametric = await page.evaluate(() => {
    return JSON.parse(document.getElementById('param-output').value);
  });

  // Lese Tabellen-Inhalte
  const tables = await page.evaluate(() => {
    const getCells = (sel) => {
      const rows = document.querySelectorAll(sel + ' tbody tr');
      return Array.from(rows).map(row =>
        Array.from(row.querySelectorAll('td')).map(td => td.textContent)
      );
    };
    return {
      cylinders: getCells('#cylinder-table'),
      spheres: getCells('#sphere-table'),
      planes: getCells('#plane-table')
    };
  });

  const bbox = parametric.boundingBox || {};
  const maxDim = Math.max(bbox.width || 0, bbox.depth || 0, bbox.height || 0);

  console.log('=== block_with_hole.stl Feature-Analyse ===');
  console.log('BBox:', JSON.stringify(bbox));
  console.log('maxDim:', maxDim);
  console.log('Dreiecke:', parametric.meta?.triangles);

  console.log('\n--- Zylinder-Tabelle (' + tables.cylinders.length + ' Zeilen) ---');
  tables.cylinders.forEach((row, i) => {
    console.log('  #' + i + ': ' + row.join(' | '));
  });

  console.log('\n--- Kugeln-Tabelle (' + tables.spheres.length + ' Zeilen) ---');
  tables.spheres.forEach((row, i) => {
    console.log('  #' + i + ': ' + row.join(' | '));
  });

  console.log('\n--- Planes-Tabelle (' + tables.planes.length + ' Zeilen) ---');
  tables.planes.forEach((row, i) => {
    console.log('  #' + i + ': ' + row.join(' | '));
  });

  // Parametrische JSON Zylinder
  console.log('\n--- Parametrische JSON Zylinder ---');
  const cyls = parametric.cylinders || [];
  cyls.forEach((c, i) => {
    console.log('  #' + i + ': ' + JSON.stringify(c));
  });

  console.log('\n--- Parametrische JSON Kugeln ---');
  const sphs = parametric.spheres || [];
  sphs.forEach((s, i) => {
    console.log('  #' + i + ': ' + JSON.stringify(s));
  });

    console.log('\n=== SOLL (laut Referenzbild) ===');
    console.log('- 6 planare Flaechen (Wuerfel)');
    console.log('- 1 Zylinder (Bohrung, kleiner Radius)');
    console.log('- 0 Kugeln');

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
})();
