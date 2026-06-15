const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve('popup.html'));
  await page.waitForSelector('#file-input');
  const input = await page.$('#file-input');
  await input.uploadFile(path.resolve('samples/block_with_hole.stl'));

  await page.waitForFunction(() => {
    const el = document.getElementById('faces');
    return el && el.textContent !== '\u2013';
  }, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  const data = await page.evaluate(() => {
    const a = window.lastAnalysis;
    if (!a) return { error: 'no analysis' };
    const maxDim = Math.max(a.boundingBox.width, a.boundingBox.depth, a.boundingBox.height);
    return {
      bbox: a.boundingBox,
      maxDim,
      cylinders: a.cylinders.map(c => ({
        axis: c.axis || c.axisLabel,
        radius: Math.round(c.radius * 100) / 100,
        radiusPct: Math.round(c.radius / maxDim * 1000) / 10,
        length: Math.round(c.length * 100) / 100,
        center: { x: Math.round(c.center.x * 10) / 10, y: Math.round(c.center.y * 10) / 10, z: Math.round(c.center.z * 10) / 10 },
        surfaceArea: Math.round(c.surfaceArea * 10) / 10
      })),
      spheres: a.spheres.map(s => ({
        radius: Math.round(s.radius * 100) / 100,
        radiusPct: Math.round(s.radius / maxDim * 1000) / 10,
        center: { x: Math.round(s.center.x * 10) / 10, y: Math.round(s.center.y * 10) / 10, z: Math.round(s.center.z * 10) / 10 },
        coverage: Math.round((s.coverage || 0) * 1000) / 10,
        sphereType: s.sphereType,
        surfaceArea: Math.round(s.surfaceArea * 10) / 10
      })),
      planesCount: a.planes.length,
      triangles: a.meta.triangles
    };
  });

  console.log('=== block_with_hole Analyse ===');
  console.log('BBox:', JSON.stringify(data.bbox));
  console.log('maxDim:', data.maxDim);
  console.log('Dreiecke:', data.triangles);
  console.log('Planes:', data.planesCount);
  console.log('\nZylinder (' + data.cylinders.length + '):');
  data.cylinders.forEach((c, i) => {
    console.log('  ' + i + ': ' + c.axis + ' r=' + c.radius + ' (' + c.radiusPct + '% maxDim) l=' + c.length + ' area=' + c.surfaceArea + ' center=(' + c.center.x + ',' + c.center.y + ',' + c.center.z + ')');
  });
  console.log('\nKugeln (' + data.spheres.length + '):');
  data.spheres.forEach((s, i) => {
    console.log('  ' + i + ': r=' + s.radius + ' (' + s.radiusPct + '% maxDim) type=' + s.sphereType + ' coverage=' + s.coverage + '% area=' + s.surfaceArea + ' center=(' + s.center.x + ',' + s.center.y + ',' + s.center.z + ')');
  });

  await browser.close();
})();
