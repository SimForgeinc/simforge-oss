// Node-only entry: offline map-intel build pipeline (filesystem-backed).
export * from './index.js';
export { loadMapSources, type MapSources } from './intel/build/sources.js';
export { KNOWN_MAPS, emitBuild, readEmitted } from './intel/cli/build-map.js';
export { xodrGeometrySha256 } from './xodr-geometry-node.js';
export { xodrGeometryProjection, verticalProfileRanges, scanXml, lineRange, child as xmlChild, childrenNamed as xmlChildrenNamed, type XmlElement } from './xodr-geometry.js';
