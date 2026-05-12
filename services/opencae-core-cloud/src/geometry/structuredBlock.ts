import { buildSurfaceFacets } from "@opencae/core";
import type { OpenCAEModelJson } from "@opencae/core";
import { buildCoreModelFromCloudMesh } from "../coreModelFromMesh";
import { CoreCloudMeshingError } from "../mesh/gmsh";
import type { CloudGeometrySource, CloudSolveRequest, CoreCloudSolveRequest, CoreVolumeMeshArtifact } from "../types";

const FACE_IDS = ["x_min", "x_max", "y_min", "y_max", "z_min", "z_max"] as const;
type StructuredBlockFaceId = typeof FACE_IDS[number];

export function structuredBlockCoreModelFromRequest(request: CoreCloudSolveRequest): {
  model: OpenCAEModelJson;
  diagnostics: unknown;
} {
  const volumeMesh = generateStructuredBlockCoreVolumeMeshFromRequest(request);
  const model = buildCoreModelFromCloudMesh({
    study: request.study as CloudSolveRequest["study"],
    displayModel: request.displayModel,
    volumeMesh,
    material: request.material,
    materials: request.materials,
    analysisType: request.analysisType ?? "static_stress",
    solverSettings: request.solverSettings
  });
  model.meshProvenance = {
    ...model.meshProvenance,
    meshSource: "structured_block_core",
    solver: "opencae-core-cloud",
    resultSource: "computed"
  };
  const fixedSet = model.surfaceSets?.find((set) => set.name === "fixed_support");
  const loadSet = model.surfaceSets?.find((set) => set.name === "load_surface");
  const generated = {
    code: "structured-block-model-generated",
    phase: "geometry_to_core_model",
    message: "Structured block Core model generated.",
    details: {
      nodeCount: volumeMesh.metadata.nodeCount,
      elementCount: volumeMesh.metadata.elementCount,
      fixedNodeCount: nodeIdsForSurfaceSet(fixedSet?.facets ?? [], model.surfaceFacets ?? []).length,
      loadSurfaceFacetCount: loadSet?.facets.length ?? 0
    }
  };
  return {
    model,
    diagnostics: {
      artifacts: {
        generatedCoreModel: model,
        meshSummary: meshSummaryArtifact(volumeMesh, [generated])
      },
      diagnostics: [
        meshGenerationDiagnostic(volumeMesh),
        generated
      ]
    }
  };
}

export function generateStructuredBlockCoreVolumeMesh(geometry: CloudGeometrySource): CoreVolumeMeshArtifact {
  return structuredBlockVolumeMesh(geometry, {
    fixedFace: "x_min",
    loadFace: "x_max"
  });
}

function generateStructuredBlockCoreVolumeMeshFromRequest(request: CoreCloudSolveRequest): CoreVolumeMeshArtifact {
  const geometry = request.geometry;
  if (!geometry || (geometry.kind !== "structured_block" && !(geometry.kind === "sample_procedural" && (geometry.sampleId === "cantilever" || geometry.sampleId === "beam")))) {
    throw new Error("Structured block Core model generation requires structured_block, cantilever, or beam geometry.");
  }
  const descriptor = blockDescriptor(geometry);
  const fixedFace = resolveStructuredBlockFace(request, "fixed_support", descriptor) ?? "x_min";
  const loadFace = resolveStructuredBlockFace(request, "load_surface", descriptor) ?? "x_max";
  assertKnownFace(fixedFace, "fixed-support-empty", "surface_mapping", "Fixed selection FS1 did not map to any structured block surface facets.", "$.study.constraints[0].selectionRef");
  assertKnownFace(loadFace, "load-surface-empty", "surface_mapping", "Load selection L1 did not map to any structured block surface facets.", "$.study.loads[0].selectionRef");
  return structuredBlockVolumeMesh(geometry, { fixedFace, loadFace });
}

function structuredBlockVolumeMesh(
  geometry: CloudGeometrySource,
  mapping: { fixedFace: StructuredBlockFaceId; loadFace: StructuredBlockFaceId }
): CoreVolumeMeshArtifact {
  const descriptor = blockDescriptor(geometry);
  const dimensions = resolveDimensions(geometry, descriptor);
  const scale = geometry.units === "m" ? 1 : 0.001;
  const length = dimensions.length * scale;
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;

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
    const face = classifyFace(facet.center, { length, width, height });
    return {
      ...facet,
      ...(face ? { sourceFaceId: face } : {}),
      ...(face === mapping.fixedFace ? { sourceSelectionRef: "FS1" } : {}),
      ...(face === mapping.loadFace ? { sourceSelectionRef: "L1" } : {})
    };
  });
  const surfaceSetByFace = Object.fromEntries(FACE_IDS.map((face) => [
    face,
    surfaceFacets.filter((facet) => facet.sourceFaceId === face).map((facet) => facet.id)
  ])) as Record<StructuredBlockFaceId, number[]>;
  const fixedFacets = surfaceSetByFace[mapping.fixedFace];
  const loadFacets = surfaceSetByFace[mapping.loadFace];

  return {
    nodes: { coordinates },
    elements: [{ type: "Tet4", connectivity, material: "solid", physicalName: "solid" }],
    surfaceFacets,
    surfaceSets: [
      { name: "fixed_support", facets: fixedFacets },
      { name: "load_surface", facets: loadFacets },
      { name: "x_min", facets: surfaceSetByFace.x_min },
      { name: "x_max", facets: surfaceSetByFace.x_max },
      { name: "y_min", facets: surfaceSetByFace.y_min },
      { name: "y_max", facets: surfaceSetByFace.y_max },
      { name: "z_min", facets: surfaceSetByFace.z_min },
      { name: "z_max", facets: surfaceSetByFace.z_max },
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

function blockDescriptor(geometry: CloudGeometrySource): Record<string, unknown> {
  return geometry.descriptor ?? geometry.geometryDescriptor ?? {};
}

function resolveDimensions(geometry: CloudGeometrySource, descriptor: Record<string, unknown>): { length: number; width: number; height: number } {
  const dimensions = objectValue(descriptor.dimensions);
  const displayDimensions = objectValue(descriptor.displayDimensions);
  const source = dimensions ?? displayDimensions ?? descriptor;
  const sampleDefaults = geometry.kind === "sample_procedural" && geometry.sampleId === "cantilever"
    ? { length: 180, width: 24, height: 24 }
    : geometry.kind === "sample_procedural" && geometry.sampleId === "beam"
      ? { length: 180, width: 24, height: 24 }
      : { length: 100, width: 30, height: 30 };
  return {
    length: positiveNumber(source.length ?? source.x ?? descriptor.length, sampleDefaults.length),
    width: positiveNumber(source.width ?? source.depth ?? source.y ?? descriptor.width ?? descriptor.depth, sampleDefaults.width),
    height: positiveNumber(source.height ?? source.z ?? descriptor.height, sampleDefaults.height)
  };
}

function resolveStructuredBlockFace(
  request: CoreCloudSolveRequest,
  role: "fixed_support" | "load_surface",
  descriptor: Record<string, unknown>
): string | undefined {
  const descriptorFace = role === "fixed_support"
    ? stringValue(descriptor.fixedFace ?? descriptor.supportFace ?? descriptor.fixedSupportFace)
    : stringValue(descriptor.loadFace ?? descriptor.forceFace ?? descriptor.loadSurfaceFace);
  if (descriptorFace) return normalizeFaceId(descriptorFace);

  const constraints = Array.isArray(request.study?.constraints) ? request.study.constraints : [];
  const loads = Array.isArray(request.study?.loads) ? request.study.loads : [];
  const selectionRef = role === "fixed_support"
    ? objectValue(constraints[0])?.selectionRef
    : objectValue(loads[0])?.selectionRef;
  if (typeof selectionRef !== "string") return undefined;
  const selection = Array.isArray(request.study?.namedSelections)
    ? request.study.namedSelections.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === selectionRef)
    : undefined;
  const refs = selection && typeof selection === "object" && Array.isArray((selection as { geometryRefs?: unknown }).geometryRefs)
    ? (selection as { geometryRefs: Array<{ entityId?: unknown; label?: unknown }> }).geometryRefs
    : [];
  for (const ref of refs) {
    const face = normalizeFaceId(stringValue(ref.entityId) ?? stringValue(ref.label));
    if (face) return face;
  }
  return undefined;
}

function normalizeFaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, StructuredBlockFaceId> = {
    xmin: "x_min",
    min_x: "x_min",
    left: "x_min",
    fixed: "x_min",
    support: "x_min",
    xmax: "x_max",
    max_x: "x_max",
    right: "x_max",
    tip: "x_max",
    load: "x_max",
    ymin: "y_min",
    min_y: "y_min",
    ymax: "y_max",
    max_y: "y_max",
    zmin: "z_min",
    min_z: "z_min",
    bottom: "z_min",
    zmax: "z_max",
    max_z: "z_max",
    top: "z_max"
  };
  return aliases[normalized] ?? normalized;
}

function assertKnownFace(value: string, code: string, phase: string, message: string, path: string): asserts value is StructuredBlockFaceId {
  if ((FACE_IDS as readonly string[]).includes(value)) return;
  throw new CoreCloudMeshingError(code, message, {
    diagnostics: [{ code, phase, message, path }]
  });
}

function classifyFace(
  center: [number, number, number] | undefined,
  dimensions: { length: number; width: number; height: number }
): StructuredBlockFaceId | undefined {
  if (!center) return undefined;
  const tolerance = Math.max(dimensions.length, dimensions.width, dimensions.height) * 1e-8;
  if (center[0] <= tolerance) return "x_min";
  if (Math.abs(center[0] - dimensions.length) <= tolerance) return "x_max";
  if (center[1] <= tolerance) return "y_min";
  if (Math.abs(center[1] - dimensions.width) <= tolerance) return "y_max";
  if (center[2] <= tolerance) return "z_min";
  if (Math.abs(center[2] - dimensions.height) <= tolerance) return "z_max";
  return undefined;
}

function meshGenerationDiagnostic(volumeMesh: CoreVolumeMeshArtifact): Record<string, unknown> {
  return {
    id: "core-cloud-mesh-generation",
    source: volumeMesh.metadata.source,
    mesher: "structured_block",
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics
  };
}

function meshSummaryArtifact(volumeMesh: CoreVolumeMeshArtifact, phaseDiagnostics: unknown[]): Record<string, unknown> {
  return {
    source: volumeMesh.metadata.source,
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics,
    phaseDiagnostics: [...phaseDiagnostics]
  };
}

function nodeIdsForSurfaceSet(facetIds: number[], facets: Array<{ id: number; nodes: number[] }>): number[] {
  const facetIdSet = new Set(facetIds);
  const nodes = new Set<number>();
  for (const facet of facets) {
    if (!facetIdSet.has(facet.id)) continue;
    for (const node of facet.nodes) nodes.add(node);
  }
  return [...nodes].sort((left, right) => left - right);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
