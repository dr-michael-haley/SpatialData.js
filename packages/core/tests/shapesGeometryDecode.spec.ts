import { vectorFromArray, Binary, type Vector } from 'apache-arrow';
import WKB from 'ol/format/WKB.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { describe, expect, it } from 'vitest';
import {
  decodeWkbPointColumnFlat,
  decodeWkbPolygonColumnFlat,
} from '../src/shapesGeometryDecode.js';

/**
 * The WKB→flat-buffer decode, the CPU-heavy half of shapes loading that now runs
 * off-thread. The claims under test are the flattening ones: exterior-ring
 * coordinates land interleaved in `positions`, and `startIndices` slices them
 * back into features (deck.gl's binary polygon contract). Round-tripped through
 * ol's own WKB writer so it exercises the real parse, not a hand-rolled fixture.
 */

function toBytes(written: string | Uint8Array): Uint8Array {
  if (written instanceof Uint8Array) {
    return written;
  }
  // ol writes WKB as a hex string; parquet delivers bytes, so decode to match.
  const bytes = new Uint8Array(written.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(written.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function wkbColumn(geometries: Array<Polygon | MultiPolygon | Point>): Vector {
  const wkb = new WKB();
  const buffers = geometries.map((g) => toBytes(wkb.writeGeometry(g)));
  return vectorFromArray(buffers, new Binary());
}

describe('decodeWkbPolygonColumnFlat', () => {
  it('flattens exterior rings and indexes them per feature', () => {
    // A triangle (3 verts) and a square (4 verts). Rings are closed in WKB but ol
    // returns the ring as written; assert against what the writer round-trips.
    const triangle = new Polygon([
      [
        [0, 0],
        [2, 0],
        [1, 2],
        [0, 0],
      ],
    ]);
    const square = new Polygon([
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
        [10, 10],
      ],
    ]);

    const result = decodeWkbPolygonColumnFlat(wkbColumn([triangle, square]));

    expect(result.kind).toBe('polygon');
    expect(result.featureCount).toBe(2);
    // startIndices are vertex offsets: feature 0 starts at 0, feature 1 after the
    // triangle's ring, and the terminal entry is the total vertex count.
    const triangleVerts = result.startIndices[1];
    expect(result.startIndices[0]).toBe(0);
    expect(result.startIndices[2]).toBe(result.positions.length / 2);
    // Each vertex is two floats.
    expect(result.positions.length).toBe(result.startIndices[2] * 2);
    // Feature 0's first vertex is the triangle's first coordinate.
    expect(result.positions[0]).toBe(0);
    expect(result.positions[1]).toBe(0);
    // Feature 1's first vertex is the square's first coordinate.
    expect(result.positions[triangleVerts * 2]).toBe(10);
    expect(result.positions[triangleVerts * 2 + 1]).toBe(10);
  });

  it('keeps every sub-polygon under the same feature identity', () => {
    // A MultiPolygon's coordinates nest one level deeper than a Polygon's:
    // [[ring, …holes], …subPolygons]. Returning the first sub-polygon's RINGS array
    // (rather than its exterior ring) fed arrays to `Number()` and emitted NaN.
    const multi = new MultiPolygon([
      [
        [
          [0, 0],
          [2, 0],
          [1, 2],
          [0, 0],
        ],
      ],
      [
        [
          [10, 10],
          [12, 10],
          [11, 12],
          [10, 10],
        ],
      ],
    ]);

    const result = decodeWkbPolygonColumnFlat(wkbColumn([multi]));
    expect(result.featureCount).toBe(1);
    // Every coordinate is a real number — the NaN regression.
    expect(Array.from(result.positions).every(Number.isFinite)).toBe(true);
    // Both disconnected pieces must be visible and pick as the same cell.
    expect(Array.from(result.positions)).toEqual([
      0, 0, 2, 0, 1, 2, 0, 0, 10, 10, 12, 10, 11, 12, 10, 10,
    ]);
    expect(Array.from(result.startIndices)).toEqual([0, 8]);
    expect(result.tessellation?.triangleCount).toBe(2);
    expect(result.tessellation?.featureScale[0]).toBeCloseTo(2);
    expect(
      Array.from(result.tessellation?.triangleData ?? [])
        .filter((_, i) => i % 4 === 3)
        .map((v) => v >>> 3)
    ).toEqual([0, 0]);
  });
});

it('excludes holes from rendered and pickable triangles', () => {
  const shape = new Polygon([
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
      [2, 2],
    ],
  ]);
  const result = decodeWkbPolygonColumnFlat(wkbColumn([shape]));
  expect(result.tessellation?.featureScale[0]).toBeCloseTo(8); // sqrt(100 - 36)
  const tess = result.tessellation;
  if (!tess) throw new Error('Missing polygon topology');
  for (let i = 0; i < tess.triangleCount; i++) {
    const ids = Array.from(tess.triangleData.slice(i * 4, i * 4 + 3));
    const x = ids.reduce((sum, id) => sum + tess.ringPositions[id * 2], 0) / 3;
    const y = ids.reduce((sum, id) => sum + tess.ringPositions[id * 2 + 1], 0) / 3;
    expect(x > 2 && x < 8 && y > 2 && y < 8).toBe(false);
  }
});

describe('decodeWkbPointColumnFlat', () => {
  it('decodes one coordinate per feature into xs/ys', () => {
    const result = decodeWkbPointColumnFlat(wkbColumn([new Point([3, 4]), new Point([5, 6])]));
    expect(result.kind).toBe('point');
    expect(result.featureCount).toBe(2);
    expect(Array.from(result.xs)).toEqual([3, 5]);
    expect(Array.from(result.ys)).toEqual([4, 6]);
  });
});
