/**
 * E2E Tests für das STL Reverse Add-on
 * Testet das Add-on im echten Browser mit Puppeteer
 */

import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADDON_PATH = resolve(__dirname, '../..');
const SAMPLE_STL = join(ADDON_PATH, 'samples/cube_ascii.stl');

// Timeout für langsame Operationen
jest.setTimeout(120000);

describe('STL Reverse Add-on E2E Tests (lokale HTML-Datei)', () => {
  let browser;
  let page;
  const popupUrl = `file://${ADDON_PATH}/popup.html`;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--disable-web-security'
      ],
      defaultViewport: { width: 1280, height: 800 }
    });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  test('Add-on popup sollte laden', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    // Prüfen ob die Drop-Zone existiert
    const dropZone = await page.$('#drop-zone');
    expect(dropZone).not.toBeNull();

    // Prüfen ob der File-Input existiert
    const fileInput = await page.$('#file-input');
    expect(fileInput).not.toBeNull();
  });

  test('UI-Elemente sollten sichtbar sein', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    // Prüfen ob wichtige UI-Elemente existieren
    const elements = [
      '#drop-zone',
      '#file-input',
      '#detail-level',
      '#copy-json',
      '#download-json'
    ];

    for (const selector of elements) {
      const element = await page.$(selector);
      expect(element).not.toBeNull();
    }
  });

  test('Detail-Slider sollte funktionieren', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    const slider = await page.$('#detail-level');
    expect(slider).not.toBeNull();

    // Slider-Wert lesen
    const initialValue = await page.$eval('#detail-level', el => el.value);
    expect(initialValue).toBeDefined();

    // Slider-Wert ändern
    await page.$eval('#detail-level', el => {
      el.value = 50;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const newValue = await page.$eval('#detail-level', el => el.value);
    expect(newValue).toBe('50');
  });

  test('Canvas-Elemente sollten existieren', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    // 2D-Canvas-Elemente prüfen
    const canvases = ['#canvas-xy', '#canvas-yz', '#canvas-zx', '#canvas-3d'];

    for (const selector of canvases) {
      const canvas = await page.$(selector);
      expect(canvas).not.toBeNull();
    }
  });

  test('HTML-Struktur sollte korrekt sein', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    // Prüfen der Tabellen für erkannte Features
    const tables = ['#plane-table', '#cylinder-table', '#cone-table', '#sphere-table'];

    for (const selector of tables) {
      const table = await page.$(selector);
      expect(table).not.toBeNull();
    }
  });

  test('CSS sollte geladen sein', async () => {
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    // Prüfen ob Stylesheets geladen sind
    const styles = await page.evaluate(() => {
      return document.styleSheets.length;
    });

    expect(styles).toBeGreaterThan(0);
  });
});

describe('Browser-Automatisierung Beispiele', () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox']
    });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  test('Screenshot erstellen', async () => {
    await page.goto('about:blank');

    // Screenshot als Buffer
    const screenshot = await page.screenshot({ encoding: 'base64' });
    expect(screenshot).toBeTruthy();
  });

  test('JavaScript im Browser ausführen', async () => {
    await page.goto('about:blank');

    // JavaScript im Browser-Kontext ausführen
    const result = await page.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        screenWidth: screen.width,
        timestamp: Date.now()
      };
    });

    expect(result.userAgent).toBeTruthy();
    expect(result.screenWidth).toBeGreaterThan(0);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  test('DOM manipulieren', async () => {
    await page.setContent('<html><body><div id="test">Original</div></body></html>');

    // DOM ändern
    await page.evaluate(() => {
      document.getElementById('test').textContent = 'Modified';
    });

    // Änderung prüfen
    const text = await page.$eval('#test', el => el.textContent);
    expect(text).toBe('Modified');
  });
});
