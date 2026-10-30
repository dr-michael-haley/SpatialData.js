---
"@spatialdata/core": patch
"zarrextra": patch
---

Read local Parquet partitions with padded or non-consecutive filenames, preserve file listings through metadata wrappers, and avoid the raw row-group decoder for local dictionary-only transcripts. AnnData tables without the optional NGFF tag now load, and table elements expose gene names and bounded dense/CSR/CSC expression-column reads for cell overlays.

Render every component and hole of multipart cell boundaries under the same feature identity, instead of dropping all but the first exterior ring.
