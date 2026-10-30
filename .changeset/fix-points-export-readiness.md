---
'@spatialdata/layers': patch
---

Keep PointsLayer.isLoaded false until the current point batch and gene filter are ready to draw, so figure exports include transcripts instead of capturing an empty or stale layer.
