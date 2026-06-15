/**
 * Gemeinsame Test-Utilities für Puppeteer-Tests
 * Garantiert sauberes Browser-Cleanup auch bei Fehlern
 */
import puppeteer from 'puppeteer';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.stl':  'model/stl'
};

/**
 * Startet einen lokalen HTTP-Server für die Addon-Dateien.
 * Web Workers mit type='module' funktionieren nicht über file://.
 * @returns {Promise<{url: string, server: http.Server, close: Function}>}
 */
export async function startLocalServer() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const filePath = join(ADDON_PATH, decodeURIComponent(urlPath));

      if (!filePath.startsWith(ADDON_PATH)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end(`Not found: ${urlPath}`);
        return;
      }

      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });

    server.on('error', reject);

    // Port 0 = OS wählt freien Port
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;
      resolvePromise({
        url,
        server,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/**
 * Startet einen Browser mit robusten Einstellungen
 * @returns {Promise<Browser>}
 */
export async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-dev-shm-usage',
      // Software-WebGL für headless (damit Three.js nicht crasht)
      '--enable-webgl',
      '--use-gl=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-accelerated-2d-canvas'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
}

/**
 * Schließt Browser sauber, auch bei Fehlern
 */
export async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (closeError) {
    console.warn('Browser-Close fehlgeschlagen, force kill...');
    try {
      browser.process()?.kill('SIGKILL');
    } catch (e) { /* ignore */ }
  }
}

/**
 * Wartet auf Analyse-Abschluss
 */
export async function waitForAnalysis(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const output = document.getElementById('param-output');
    return output && output.value && output.value.length > 10;
  }, { timeout });
}

/**
 * Lädt eine STL-Datei und wartet auf Analyse
 */
export async function loadStlAndWait(page, stlPath, timeout = 90000) {
  const fileInput = await page.$('#file-input');
  if (!fileInput) throw new Error('File input nicht gefunden');
  await fileInput.uploadFile(stlPath);
  await waitForAnalysis(page, timeout);
}

export default { startLocalServer, launchBrowser, closeBrowser, waitForAnalysis, loadStlAndWait };
