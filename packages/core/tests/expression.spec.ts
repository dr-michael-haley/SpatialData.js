import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import { readExpressionColumn } from '../src/models/expression';

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
function vector(
  store: Map<zarr.AbsolutePath, Uint8Array>,
  path: string,
  values: number[],
  shape = [values.length]
) {
  store.set(
    `/${path}/.zarray`,
    json({
      zarr_format: 2,
      shape,
      chunks: shape,
      dtype: '<f8',
      compressor: null,
      filters: null,
      fill_value: 0,
      order: 'C',
    })
  );
  store.set(
    `/${path}/${shape.map(() => 0).join('.')}`,
    new Uint8Array(new Float64Array(values).buffer)
  );
}
function fixture(kind: 'dense' | 'csr_matrix' | 'csc_matrix') {
  const store = new Map<zarr.AbsolutePath, Uint8Array>();
  if (kind === 'dense') vector(store, 'X', [0, 2, 3, 0, 0, 4, 0, 5, 0], [3, 3]);
  else {
    store.set('/X/.zgroup', json({ zarr_format: 2 }));
    store.set('/X/.zattrs', json({ 'encoding-type': kind, shape: [3, 3] }));
    vector(store, 'X/data', kind === 'csr_matrix' ? [2, 3, 4, 5] : [2, 5, 3, 4]);
    vector(store, 'X/indices', kind === 'csr_matrix' ? [1, 2, 2, 1] : [0, 2, 0, 1]);
    vector(store, 'X/indptr', kind === 'csr_matrix' ? [0, 2, 3, 4] : [0, 0, 2, 4]);
  }
  return zarr.root(store).resolve('X');
}
describe('bounded gene expression reads', () => {
  for (const kind of ['dense', 'csr_matrix', 'csc_matrix'] as const) {
    it(`reads one gene from ${kind}, including zeros and empty columns`, async () => {
      expect([...(await readExpressionColumn(fixture(kind), 1))]).toEqual([2, 0, 5]);
      expect([...(await readExpressionColumn(fixture(kind), 0))]).toEqual([0, 0, 0]);
      expect([...(await readExpressionColumn(fixture(kind), 2))]).toEqual([3, 4, 0]);
    });
  }
  it('rejects missing genes and cancellation', async () => {
    await expect(readExpressionColumn(fixture('dense'), 3)).rejects.toThrow('gene');
    const controller = new AbortController();
    controller.abort();
    await expect(readExpressionColumn(fixture('dense'), 1, controller.signal)).rejects.toThrow();
  });
});
