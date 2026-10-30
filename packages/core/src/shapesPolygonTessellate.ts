/**
 * Tessellate flat polygon rings into **compact topology** for a vertex-pulling
 * renderer (`FlatPolygonLayer`): a shared ring-position array plus a per-triangle
 * record. The vertex shader reconstructs each vertex's position and its boundary
 * edge-distance from `gl_VertexID` + these two buffers (uploaded as textures), so
 * nothing is stored per de-indexed vertex — positions are shared, and the
 * edge-distance is *computed*, not stored.
 *
 * THE OUTLINE ENCODING. A filled polygon is earcut into triangles; a fragment has no
 * idea where the real polygon boundary is, and a naive wireframe would light up the
 * internal earcut edges (diagonals). We record, per triangle, which of its three
 * edges are true polygon-boundary edges (an edge is a boundary edge iff its two
 * endpoints are consecutive in the ring, mod ring length). The shader turns those
 * flags into a `vec3` of edge-distances — the triangle height at the opposite vertex
 * for a boundary edge, a large sentinel for an internal one — so `min(vec3)` in the
 * fragment is the distance to the nearest *boundary* edge, and only the outline draws.
 *
 * Rings are exterior-only and simple (no holes) — matching the WKB decode, which
 * extracts `getCoordinates()[0]`. Lives in core so the geometry worker can run it
 * right after decoding and transfer the buffers back (off the main thread); the
 * renderer keeps a main-thread fallback for the no-worker path.
 */

import earcutModule from 'earcut';

// earcut v3 ships as an ES module; tolerate both default and namespace interop.
const earcut =
  (earcutModule as unknown as { default?: typeof earcutModule }).default ?? earcutModule;

export interface TessellatedPolygons {
  /** Shared ring vertices, interleaved XY (closing duplicates dropped). Length
   *  `2 * ringVertexCount`. Indexed by the triangle records. */
  ringPositions: Float32Array;
  /** Per-triangle record `[g0, g1, g2, feature*8 + boundaryFlags]`, where `g*` are
   *  ring-vertex indices and the low 3 bits flag which edges are boundary edges
   *  (bit0: edge BC = g1→g2, bit1: edge CA = g2→g0, bit2: edge AB = g0→g1). Length
   *  `4 * triangleCount`. */
  triangleData: Uint32Array;
  triangleCount: number;
  ringVertexCount: number;
  /** Per-feature characteristic size (√area, world units), one per feature. The
   *  shader uses it to keep the outline from dominating when a shape is small on
   *  screen. Length `featureCount`. */
  featureScale: Float32Array;
}

/** Absolute vertex offsets for one polygon (exterior, holes, terminal offset). */
export interface PolygonPart {
  featureIndex: number;
  ringOffsets: readonly number[];
}

/** Tessellate polygons, preserving holes and a shared identity across disconnected parts. */
export function tessellateFlatPolygons(
  positions: Float32Array,
  startIndices: Int32Array,
  parts?: readonly PolygonPart[]
): TessellatedPolygons {
  const featureCount = Math.max(0, startIndices.length - 1);
  const polygons =
    parts ??
    Array.from({ length: featureCount }, (_, featureIndex) => ({
      featureIndex,
      ringOffsets: [startIndices[featureIndex], startIndices[featureIndex + 1]],
    }));
  let triangleCount = 0;
  let ringVertexCount = 0;
  const decoded = polygons.map(({ featureIndex, ringOffsets }) => {
    const coords: number[] = [],
      holes: number[] = [],
      next: number[] = [];
    for (let r = 0; r + 1 < ringOffsets.length; r++) {
      const start = ringOffsets[r];
      let end = ringOffsets[r + 1];
      if (
        end - start >= 2 &&
        positions[start * 2] === positions[(end - 1) * 2] &&
        positions[start * 2 + 1] === positions[(end - 1) * 2 + 1]
      )
        end--;
      if (end - start < 3) {
        if (r === 0) break;
        continue;
      }
      const base = coords.length / 2;
      if (r > 0) holes.push(base);
      for (let i = start; i < end; i++) {
        coords.push(positions[i * 2], positions[i * 2 + 1]);
        next.push(i + 1 === end ? base : base + i - start + 1);
      }
    }
    const tris = earcut(coords, holes);
    const base = ringVertexCount;
    ringVertexCount += coords.length / 2;
    triangleCount += tris.length / 3;
    return { featureIndex, coords, tris, next, base };
  });
  const ringPositions = new Float32Array(ringVertexCount * 2);
  const triangleData = new Uint32Array(triangleCount * 4);
  const areas = new Float64Array(featureCount);
  let t = 0;
  for (const { featureIndex, coords, tris, next, base } of decoded) {
    ringPositions.set(coords, base * 2);
    const boundary = (a: number, b: number) => next[a] === b || next[b] === a;
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k],
        b = tris[k + 1],
        c = tris[k + 2];
      const flags =
        Number(boundary(b, c)) | (Number(boundary(c, a)) << 1) | (Number(boundary(a, b)) << 2);
      triangleData[t * 4] = base + a;
      triangleData[t * 4 + 1] = base + b;
      triangleData[t * 4 + 2] = base + c;
      triangleData[t * 4 + 3] = featureIndex * 8 + flags;
      t++;
      areas[featureIndex] +=
        Math.abs(
          (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
            (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2])
        ) * 0.5;
    }
  }
  const featureScale = Float32Array.from(areas, Math.sqrt);
  return { ringPositions, triangleData, triangleCount, ringVertexCount, featureScale };
}
