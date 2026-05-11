import { buildSurfaceFacets } from "@opencae/core";
import type { CloudGeometrySource, CoreVolumeMeshArtifact } from "../types";

export function generateStructuredBlockCoreVolumeMesh(geometry: CloudGeometrySource): CoreVolumeMeshArtifact {
  if (geometry.kind !== "structured_block") {
    throw new Error("Structured block mesh generation requires geometry.kind=structured_block.");
  }
  const descriptor = geometry.geometryDescriptor ?? {};
  const scale = geometry.units === "m" ? 1 : 0.001;
  const length = positiveNumber(descriptor.length, 100) * scale;
  const width = positiveNumber(descriptor.width ?? descriptor.depth, 30) * scale;
  const height = positiveNumber(descriptor.height, 30) * scale;

  const coordinates = [
    0, 0, 0,
    length, 0, 0,
    0, width, 0,
    length, width, 0,
    0, 0, height,
    length, 0, height,
    0, width, height,
    length, width, height
  ];
  const connectivity = [
    0, 1, 3, 7,
    0, 3, 2, 7,
    0, 2, 6, 7,
    0, 6, 4, 7,
    0, 4, 5, 7,
    0, 5, 1, 7
  ];
  const surfaceFacets = buildSurfaceFacets({
    coordinates,
    elementBlocks: [{ name: "solid", type: "Tet4", material: "solid", connectivity }]
  }).map((facet) => {
    if ((facet.center?.[0] ?? 0) <= length * 1e-8) {
      return { ...facet, sourceSelectionRef: "FS1", sourceFaceId: "structured-block-fixed" };
    }
    if (Math.abs((facet.center?.[0] ?? 0) - length) <= length * 1e-8) {
      return { ...facet, sourceSelectionRef: "L1", sourceFaceId: "structured-block-load" };
    }
    return facet;
  });
  const fixedFacets = surfaceFacets.filter((facet) => facet.sourceSelectionRef === "FS1").map((facet) => facet.id);
  const loadFacets = surfaceFacets.filter((facet) => facet.sourceSelectionRef === "L1").map((facet) => facet.id);

  return {
    nodes: { coordinates },
    elements: [{ type: "Tet4", connectivity, material: "solid", physicalName: "solid" }],
    surfaceFacets,
    surfaceSets: [
      { name: "fixed_support", facets: fixedFacets },
      { name: "load_surface", facets: loadFacets },
      { name: "base_surfaces", facets: surfaceFacets.map((facet) => facet.id) }
    ],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: "structured_block",
      nodeCount: coordinates.length / 3,
      elementCount: connectivity.length / 4,
      surfaceFacetCount: surfaceFacets.length,
      physicalGroups: [
        { dimension: 3, tag: 1, name: "solid", entityCount: connectivity.length / 4 },
        { dimension: 2, tag: 2, name: "fixed_support", entityCount: fixedFacets.length },
        { dimension: 2, tag: 3, name: "load_surface", entityCount: loadFacets.length }
      ],
      connectedComponentCount: 1,
      meshQuality: {
        minTetVolume: (length * width * height) / 6,
        maxTetVolume: (length * width * height) / 6,
        invertedElementCount: 0
      },
      diagnostics: ["structured_block direct Tet4 mesh"],
      units: "m"
    }
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
