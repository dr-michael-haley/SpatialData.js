import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { FolderStore, openExtraConsolidated } from 'zarrextra';
import SpatialDataPointsSource from '../src/models/VPointsSource';

describe('local multipart points', () => {
  it('reads all non-consecutive, zero-padded parts with their gene dictionaries', async () => {
    const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const files: Record<string, Uint8Array> = {
      '.zgroup': json({ zarr_format: 2 }),
      '.zattrs': json({
        spatialdata_attrs: { spatialdata_software_version: '0.3.0', version: '0.1' },
      }),
      'points/.zgroup': json({ zarr_format: 2 }),
      'points/transcripts/.zgroup': json({ zarr_format: 2 }),
      'points/transcripts/.zattrs': json({
        axes: ['x', 'y'],
        'encoding-type': 'ngff:points',
        spatialdata_attrs: { version: '0.1', feature_key: 'gene' },
      }),
    };
    for (const name of ['part.019.parquet', 'part.005.parquet'])
      files[`points/transcripts/points.parquet/${name}`] = await readFile(
        new URL(`./fixtures/gapped-points/${name}`, import.meta.url)
      );
    const store = FolderStore.fromFiles(
      Object.entries(files).map(([path, bytes]) =>
        Object.assign(new Blob([Uint8Array.from(bytes)]), {
          name: path.split('/').at(-1)!,
          webkitRelativePath: `data.zarr/${path}`,
        })
      )
    );
    const opened = await openExtraConsolidated(store);
    if (!opened.ok) throw opened.error;
    const source = new SpatialDataPointsSource({
      store: opened.value.zarritaStore,
      fileType: '.zarr',
    });
    const result = await source.loadPoints('points/transcripts', { includeFeatureCodes: true });
    expect(result.shape).toEqual([2, 4]);
    expect(Array.from(result.data[0])).toEqual([1, 2, 3, 4]);
    expect(result.featureCodes?.length).toBe(4);
    const catalog = await source.listPointsFeatures('points/transcripts');
    const byCode = new Map(catalog?.entries.map((entry) => [entry.code, entry.name]));
    expect(Array.from(result.featureCodes ?? [], (code) => byCode.get(code))).toEqual([
      'A',
      'B',
      'B',
      'C',
    ]);
  });
});
