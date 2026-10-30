// Worker-safe WKB → flat-buffer shape geometry decode.
//
// This is the CPU-heavy half of shapes loading — the WKB parse — factored out of
// `VShapesSource` so it can run *either* on the main thread (fallback) or inside
// the parquet worker. It depends only on `apache-arrow` + `ol/format/WKB`, never on
// zarrita/the store, so it is safe to import into the worker bundle.
//
// It produces **flat GeoArrow-style typed arrays** (interleaved coordinates +
// vertex offsets) rather than the historical `Array<Array<[number, number]>>`.
// Flat buffers are transferable across the worker boundary zero-copy and feed a
// binary deck.gl `PolygonLayer` directly — no per-vertex JS object ever exists.

import type { Table as ArrowTable } from 'apache-arrow';
import type { Vector } from 'apache-arrow/vector';
import WKB from 'ol/format/WKB.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import {
  tessellateFlatPolygons,
  type PolygonPart,
  type TessellatedPolygons,
} from './shapesPolygonTessellate.js';

export interface FlatPolygonGeometry {
  kind: 'polygon';
  /** Interleaved coordinates of all rings `[x0, y0, x1, y1, …]` for all features. */
  positions: Float32Array;
  /**
   * Vertex offset where each feature's geometry begins; length `featureCount + 1`,
   * last entry = total vertex count. This is deck.gl's binary `startIndices`.
   */
  startIndices: Int32Array;
  featureCount: number;
  /** Vertex-pulling render topology preserving multipart geometries and holes. */
  tessellation?: TessellatedPolygons;
}

export interface FlatPointGeometry {
  kind: 'point';
  xs: Float32Array;
  ys: Float32Array;
  featureCount: number;
}

export type FlatShapeGeometry = FlatPolygonGeometry | FlatPointGeometry;

/** Extract the geometry column and assert it is Arrow `Binary` (WKB bytes). */
export function getBinaryGeometryColumn(table: ArrowTable, columnName: string): Vector {
  const geometryColumn = table.getChild(columnName);
  if (!geometryColumn) {
    throw new Error(`Column ${columnName} not found in parquet table`);
  }
  if (geometryColumn.type.toString() !== 'Binary') {
    throw new Error(
      `Expected geometry column to have Binary type but got ${geometryColumn.type.toString()}`
    );
  }
  return geometryColumn;
}

/**
 * Whether the geometry column is WKB-encoded. Mirrors GeoPandas' convention: the
 * `ARROW:extension:name` field metadata is `geoarrow.wkb` when present, and absent
 * metadata (pre-1.0.0 geopandas) is treated as WKB. GeoArrow-native encodings are
 * not yet supported here (that is the tiled-artifact path — see ADR 0002).
 */
export function isWkbColumn(table: ArrowTable, columnName: string): boolean {
  const encoding = table.schema.fields
    .find((field) => field.name === columnName)
    ?.metadata?.get('ARROW:extension:name');
  if (!encoding) {
    return true;
  }
  return encoding === 'geoarrow.wkb';
}

/** Decode every component and hole, retaining one feature identity per WKB row. */
export function decodeWkbPolygonColumnFlat(geometryColumn: Vector): FlatPolygonGeometry {
  const wkb = new WKB();
  const raw = geometryColumn.toArray();
  const featureCount = raw.length;
  const features = [];
  const parts: PolygonPart[] = [];
  const startIndices = new Int32Array(featureCount + 1);
  let totalVertices = 0;
  for (let i = 0; i < featureCount; i++) {
    const geometry = wkb.readGeometry(raw[i]);
    const polygons =
      geometry instanceof MultiPolygon
        ? geometry.getCoordinates()
        : geometry instanceof Polygon
          ? [geometry.getCoordinates()]
          : [];
    features.push(polygons);
    startIndices[i] = totalVertices;
    for (const rings of polygons) {
      const offsets = [];
      for (const ring of rings) {
        offsets.push(totalVertices);
        totalVertices += ring.length;
      }
      offsets.push(totalVertices);
      parts.push({ featureIndex: i, ringOffsets: offsets });
    }
  }
  startIndices[featureCount] = totalVertices;
  const positions = new Float32Array(totalVertices * 2);
  let cursor = 0;
  for (const polygons of features) {
    for (const rings of polygons) {
      for (const ring of rings) {
        for (const coordinate of ring) {
          positions[cursor++] = coordinate[0];
          positions[cursor++] = coordinate[1];
        }
      }
    }
  }
  // Topology must be built before ring/part boundaries are discarded, on both
  // worker and fallback paths. Concatenating separate rings would fill gaps/holes.
  const tessellation = tessellateFlatPolygons(positions, startIndices, parts);
  return { kind: 'polygon', positions, startIndices, featureCount, tessellation };
}

/**
 * Decode a WKB point column into flat `xs`/`ys` (one coordinate per feature).
 * Mirrors the historical `_decodeWkbColumnFlat`: the first flat coordinate pair.
 */
export function decodeWkbPointColumnFlat(geometryColumn: Vector): FlatPointGeometry {
  const wkb = new WKB();
  const raw = geometryColumn.toArray() as ArrayLike<ArrayBuffer>;
  const featureCount = raw.length;
  const xs = new Float32Array(featureCount);
  const ys = new Float32Array(featureCount);
  for (let i = 0; i < featureCount; i += 1) {
    const flat = (
      wkb.readGeometry(raw[i]) as unknown as { getFlatCoordinates: () => Array<number | bigint> }
    ).getFlatCoordinates();
    xs[i] = Number(flat[0]);
    ys[i] = Number(flat[1]);
  }
  return { kind: 'point', xs, ys, featureCount };
}

/**
 * Decode a WKB geometry column into flat buffers, dispatched by geometry kind.
 * `circle` and `point` both decode to point coordinates (a circle is a point plus
 * a separately-loaded radius column).
 */
export function decodeShapesGeometryFlat(
  table: ArrowTable,
  columnName: string,
  geometryKind: 'polygon' | 'circle' | 'point'
): FlatShapeGeometry {
  const column = getBinaryGeometryColumn(table, columnName);
  if (!isWkbColumn(table, columnName)) {
    throw new Error('Unexpected encoding type for shapes geometry; only WKB is supported');
  }
  return geometryKind === 'polygon'
    ? decodeWkbPolygonColumnFlat(column)
    : decodeWkbPointColumnFlat(column);
}
