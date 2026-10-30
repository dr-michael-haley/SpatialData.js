---
'@spatialdata/core': patch
'@spatialdata/vis': minor
'zarrextra': patch
---

Keep cell-to-table joins within the requested region when instance IDs repeat
across regions. Preserve requests for the region column in tooltip and colour data.

Allow host controls inside SpatialCanvasViewer's image context and expose
onEntryStatusChange for embedded viewers to show layer errors and notices.

Import optional codecs without initializing a JavaScript Function constructor.
