import {
  formatNumber, clamp, heightToColor,
  formatBytes, describeDetailLevel,
  computePointBounds, computePrismBounds,
  dedupePolygonPoints, polygonSignedArea2d,
  normalizeVector, defaultBounds, rectangleFromBounds
} from '../utils.js';

describe('utils.js', () => {
  describe('formatNumber', () => {
    test('formats finite number with German locale', () => {
      const result = formatNumber(1234.567);
      expect(result).toMatch(/1[.]?234/);
    });
    test('returns "0" for non-finite', () => {
      expect(formatNumber(NaN)).toBe('0');
      expect(formatNumber(Infinity)).toBe('0');
    });
  });

  describe('clamp', () => {
    test('clamps within range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
    test('returns min for non-finite', () => {
      expect(clamp(NaN, 2, 10)).toBe(2);
    });
  });

  describe('heightToColor', () => {
    test('returns rgb string', () => {
      expect(heightToColor(0)).toMatch(/^rgb\(/);
      expect(heightToColor(0.5)).toMatch(/^rgb\(/);
      expect(heightToColor(1)).toMatch(/^rgb\(/);
    });
  });

  describe('formatBytes', () => {
    test('formats bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(1024)).toMatch(/1.*KB/);
      expect(formatBytes(1048576)).toMatch(/1.*MB/);
    });
    test('handles non-finite', () => {
      expect(formatBytes(NaN)).toBe('0 B');
    });
  });

  describe('describeDetailLevel', () => {
    test('returns correct descriptions', () => {
      expect(describeDetailLevel(95)).toBe('maximale Konturen');
      expect(describeDetailLevel(80)).toBe('feine Konturen');
      expect(describeDetailLevel(65)).toBe('ausgewogene Konturen');
      expect(describeDetailLevel(40)).toBe('glatte/vereinfachte Konturen');
    });
  });

  describe('computePointBounds', () => {
    test('computes bounds from points', () => {
      const bounds = computePointBounds([[0, 0, 0], [10, 20, 30]]);
      expect(bounds.min).toEqual([0, 0, 0]);
      expect(bounds.width).toBe(10);
      expect(bounds.depth).toBe(20);
      expect(bounds.height).toBe(30);
    });
    test('returns defaults for empty', () => {
      const bounds = computePointBounds([]);
      expect(bounds.width).toBe(1);
    });
  });

  describe('computePrismBounds', () => {
    test('computes bounds from prisms', () => {
      const bounds = computePrismBounds([
        { xMin: 0, yMin: 0, zMin: 0, xMax: 5, yMax: 5, zMax: 5 }
      ]);
      expect(bounds.width).toBe(5);
      expect(bounds.depth).toBe(5);
      expect(bounds.height).toBe(5);
    });
  });

  describe('dedupePolygonPoints', () => {
    test('removes duplicate consecutive points', () => {
      const result = dedupePolygonPoints([[0, 0], [0, 0], [1, 0], [1, 1]]);
      expect(result.length).toBe(3);
    });
    test('removes closing duplicate', () => {
      const result = dedupePolygonPoints([[0, 0], [1, 0], [1, 1], [0, 0]]);
      expect(result.length).toBe(3);
    });
  });

  describe('polygonSignedArea2d', () => {
    test('computes positive area for CCW triangle', () => {
      const area = polygonSignedArea2d([[0, 0], [1, 0], [0, 1]]);
      expect(area).toBeCloseTo(0.5);
    });
    test('returns 0 for fewer than 3 points', () => {
      expect(polygonSignedArea2d([[0, 0], [1, 0]])).toBe(0);
    });
  });

  describe('normalizeVector', () => {
    test('normalizes a vector', () => {
      const n = normalizeVector([3, 0, 0]);
      expect(n[0]).toBeCloseTo(1);
      expect(n[1]).toBeCloseTo(0);
      expect(n[2]).toBeCloseTo(0);
    });
    test('returns zero for zero vector', () => {
      expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
    });
  });

  describe('defaultBounds', () => {
    test('returns zero bounds', () => {
      expect(defaultBounds()).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    });
  });

  describe('rectangleFromBounds', () => {
    test('returns rectangle for valid bounds', () => {
      const rect = rectangleFromBounds({ minX: 0, minY: 0, maxX: 10, maxY: 5 });
      expect(rect).toHaveLength(4);
      expect(rect[0]).toEqual([0, 0]);
      expect(rect[2]).toEqual([10, 5]);
    });
    test('returns null for zero-area bounds', () => {
      expect(rectangleFromBounds({ minX: 0, minY: 0, maxX: 0, maxY: 5 })).toBeNull();
    });
  });
});
