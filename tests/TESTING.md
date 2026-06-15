# Testing & Browser-Automatisierung

## Verfügbare Test-Kommandos

```bash
# Alle Tests ausführen
npm test

# Nur Unit-Tests
npm run test:unit

# Nur E2E-Tests (Browser-Automatisierung)
npm run test:e2e

# Add-on validieren (Mozilla Linter)
npm run lint
```

## Unit-Tests

Die Unit-Tests in `tests/analysis-core.test.js` testen die Kern-Logik:

- **STL-Parsing**: ASCII und Binary STL-Dateien
- **Mesh-Analyse**: Bounding Box, Face-Counting
- **Feature-Erkennung**: Planare Flächen, Zylinder, Kegel, Kugeln

## E2E-Tests (Browser-Automatisierung)

Die E2E-Tests in `tests/e2e/addon.test.js` verwenden Puppeteer für echte Browser-Tests:

- UI-Element-Existenz
- Slider-Funktionalität
- Canvas-Rendering
- CSS-Loading

---

## Browser-Automatisierung: Was ich (Claude) kann

### 1. Puppeteer-Funktionen

```javascript
// Browser starten
const browser = await puppeteer.launch({
  headless: false,  // true für unsichtbar
  args: ['--no-sandbox']
});

// Seite öffnen
const page = await browser.newPage();
await page.goto('https://example.com');

// DOM abfragen
const element = await page.$('#my-element');
const text = await page.$eval('#my-element', el => el.textContent);

// Klicken & Tippen
await page.click('#button');
await page.type('#input', 'Text eingeben');

// Screenshots
await page.screenshot({ path: 'screenshot.png' });

// PDF generieren
await page.pdf({ path: 'page.pdf' });

// JavaScript im Browser ausführen
const result = await page.evaluate(() => {
  return document.title;
});
```

### 2. Was ich automatisieren kann

| Aktion | Möglich | Beispiel |
|--------|---------|----------|
| Seiten öffnen | Ja | `page.goto(url)` |
| Klicken | Ja | `page.click(selector)` |
| Text eingeben | Ja | `page.type(selector, text)` |
| Dateien hochladen | Ja | `input.uploadFile(path)` |
| Screenshots | Ja | `page.screenshot()` |
| PDF erstellen | Ja | `page.pdf()` |
| DOM auslesen | Ja | `page.$eval()` |
| JavaScript ausführen | Ja | `page.evaluate()` |
| Netzwerk überwachen | Ja | `page.on('request')` |
| Cookies setzen | Ja | `page.setCookie()` |
| Local Storage | Ja | Via `page.evaluate()` |
| Drag & Drop | Ja | Via Events |
| Multi-Tab | Ja | `browser.newPage()` |
| Formulare ausfüllen | Ja | `page.type()` |

### 3. Einschränkungen

- **Echte Benutzer-Interaktion**: Ich kann den Browser steuern, aber du siehst es nicht live
- **Extension-Testing**: Chrome-Extensions sind kompliziert zu testen (ID-Problem)
- **Sicherheit**: Headless-Browser können von manchen Seiten blockiert werden
- **Ressourcen**: Browser-Tests brauchen Zeit und RAM

### 4. Typischer Workflow für dich

```bash
# 1. Tests ausführen (ich führe sie aus, du siehst das Ergebnis)
npm run test:e2e

# 2. Add-on manuell testen
web-ext run

# 3. Add-on validieren
npm run lint
```

### 5. Was ich für dich tun kann

1. **Tests schreiben & ausführen**: Automatisierte Tests für alle Funktionen
2. **Screenshots machen**: Visuelle Überprüfung der UI
3. **Regressionstests**: Nach Änderungen prüfen ob alles noch funktioniert
4. **Performance messen**: Ladezeiten, Rendering-Performance
5. **Accessibility prüfen**: Barrierefreiheit testen
6. **Cross-Browser**: Mit verschiedenen Viewport-Größen testen

---

## Beispiel: Kompletter Test-Workflow

```javascript
// Beispiel: Add-on-Funktion automatisch testen
import puppeteer from 'puppeteer';

async function testSTLUpload() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  // Add-on Popup öffnen
  await page.goto('file:///path/to/popup.html');

  // STL-Datei hochladen
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile('/path/to/test.stl');

  // Auf Verarbeitung warten
  await page.waitForSelector('#param-output:not(:empty)');

  // Ergebnis prüfen
  const output = await page.$eval('#param-output', el => el.value);
  const parsed = JSON.parse(output);

  console.log('Erkannte Flächen:', parsed.planes.length);
  console.log('Erkannte Zylinder:', parsed.cylinders.length);

  // Screenshot machen
  await page.screenshot({ path: 'result.png' });

  await browser.close();
}
```

---

## Firefox-spezifisches Testen

Für Firefox-Extension-Testing mit `web-ext`:

```bash
# Add-on in Firefox starten
web-ext run

# Mit bestimmtem Firefox-Profil
web-ext run --firefox-profile=testing

# Mit Entwickler-Tools
web-ext run --devtools

# Automatisches Neuladen bei Änderungen
web-ext run --watch-file=popup.js
```
