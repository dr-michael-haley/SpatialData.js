import * as zarr from 'zarrita';

const BLOCK = 262144;
const MAX_CELLS = 5_000_000;

async function numericSlice(
  array: zarr.Array<zarr.DataType, zarr.Readable>,
  selection: (zarr.Slice | number | null)[],
  signal?: AbortSignal
): Promise<Float64Array> {
  signal?.throwIfAborted();
  if (array.is('number')) {
    return Float64Array.from((await zarr.get(array, selection)).data);
  }
  if (array.is('bigint')) {
    const values = (await zarr.get(array, selection)).data;
    return Float64Array.from(values, (value) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n))
        throw new Error('Expression value exceeds exact integer precision.');
      return n;
    });
  }
  throw new Error(`Expression matrix must be numeric, received ${array.dtype}.`);
}

/** Read one gene without materialising the cell-by-gene matrix, including CSR and CSC. */
export async function readExpressionColumn(
  location: zarr.Location<zarr.Readable>,
  column: number,
  signal?: AbortSignal
): Promise<Float64Array> {
  const node = await zarr.open(location);
  const shape = node instanceof zarr.Array ? node.shape : node.attrs.shape;
  if (
    !Array.isArray(shape) ||
    shape.length !== 2 ||
    !shape.every((n) => Number.isSafeInteger(n) && n >= 0)
  ) {
    throw new Error('Expression matrix has no valid two-dimensional shape.');
  }
  const [rows, columns] = shape;
  if (!Number.isSafeInteger(column) || column < 0 || column >= columns)
    throw new Error('Unknown gene index.');
  if (rows > MAX_CELLS)
    throw new Error(`Expression overlay exceeds the ${MAX_CELLS.toLocaleString()} cell limit.`);
  const result = new Float64Array(rows);
  if (node instanceof zarr.Array) {
    for (let row = 0; row < rows; row += 4096) {
      const values = await numericSlice(
        node,
        [zarr.slice(row, Math.min(rows, row + 4096)), column],
        signal
      );
      result.set(values, row);
    }
    return result;
  }
  const encoding = node.attrs['encoding-type'];
  if (encoding !== 'csr_matrix' && encoding !== 'csc_matrix')
    throw new Error(`Unsupported expression encoding: ${encoding}`);
  const [data, indices, indptr] = await Promise.all(
    ['data', 'indices', 'indptr'].map((name) => zarr.open(node.resolve(name), { kind: 'array' }))
  );
  if (
    data.shape.length !== 1 ||
    indices.shape[0] !== data.shape[0] ||
    indptr.shape[0] !== (encoding === 'csr_matrix' ? rows : columns) + 1
  ) {
    throw new Error('Invalid sparse matrix dimensions.');
  }
  const pointerStart = encoding === 'csc_matrix' ? column : 0;
  const pointerEnd = encoding === 'csc_matrix' ? column + 2 : rows + 1;
  const ptr = await numericSlice(indptr, [zarr.slice(pointerStart, pointerEnd)], signal);
  for (let i = 0; i < ptr.length; i++) {
    if (
      !Number.isSafeInteger(ptr[i]) ||
      ptr[i] < 0 ||
      ptr[i] > data.shape[0] ||
      (i > 0 && ptr[i] < ptr[i - 1])
    ) {
      throw new Error('Invalid sparse matrix pointers.');
    }
  }
  let row = 0;
  for (let start = ptr[0]; start < ptr[ptr.length - 1]; start += BLOCK) {
    const stop = Math.min(ptr[ptr.length - 1], start + BLOCK);
    const [values, ids] = await Promise.all([
      numericSlice(data, [zarr.slice(start, stop)], signal),
      numericSlice(indices, [zarr.slice(start, stop)], signal),
    ]);
    for (let i = 0; i < ids.length; i++) {
      if (
        !Number.isSafeInteger(ids[i]) ||
        ids[i] < 0 ||
        ids[i] >= (encoding === 'csr_matrix' ? columns : rows)
      ) {
        throw new Error('Invalid sparse matrix index.');
      }
      if (encoding === 'csc_matrix') result[ids[i]] += values[i];
      else {
        while (row + 1 < ptr.length && start + i >= ptr[row + 1]) row++;
        if (ids[i] === column) result[row] += values[i];
      }
    }
  }
  return result;
}
