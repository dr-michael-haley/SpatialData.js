import { SpatialData } from '@spatialdata/core';
import { renderStackSchema } from '@spatialdata/layers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useImageLayerContext } from '../src/SpatialCanvas/ImageLayerContext';
import { SpatialCanvasViewer } from '../src/SpatialCanvas/SpatialCanvasViewer';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpatialCanvasViewer embedding', () => {
  it('gives host controls image context even when they portal outside the canvas', () => {
    function HostControls() {
      const image = useImageLayerContext('unloaded');
      return createPortal(<p>{image ? 'Image loaded' : 'Waiting for image'}</p>, document.body);
    }
    render(
      <SpatialCanvasViewer coordinateSystem="global" viewState={null} onViewStateChange={() => {}}>
        <HostControls />
      </SpatialCanvasViewer>
    );
    expect(screen.getByText('Waiting for image')).toBeDefined();
  });

  it('reports an unresolved entry to its host without needing a GPU', async () => {
    const store = {
      async get() {
        return undefined;
      },
      contents() {
        return [];
      },
    };
    const spatialData = new SpatialData(store, { tree: {}, zarritaStore: store });
    const onEntryStatusChange = vi.fn();
    const renderStack = renderStackSchema.parse({
      entries: [
        { kind: 'spatial', id: 'missing', source: { elementType: 'image', elementKey: 'absent' } },
      ],
    });
    render(
      <SpatialCanvasViewer
        spatialData={spatialData}
        coordinateSystem="global"
        renderStack={renderStack}
        viewState={null}
        onViewStateChange={() => {}}
        onEntryStatusChange={onEntryStatusChange}
      />
    );
    await waitFor(() =>
      expect(onEntryStatusChange).toHaveBeenCalledWith(
        'missing',
        expect.objectContaining({
          errors: [
            expect.objectContaining({
              resource: 'element',
              error: expect.objectContaining({ kind: 'element-not-found' }),
            }),
          ],
        })
      )
    );
  });
});
