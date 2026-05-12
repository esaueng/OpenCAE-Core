import {
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  nodeSetFromSurfaceSet,
  preflightCoreModel,
  validateModelJson,
  type BoundaryConditionJson,
  type IsotropicLinearElasticMaterialJson,
  type LoadJson,
  type NodeSetJson,
  type OpenCAEModelJson,
  type StepJson,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import type { DynamicTet4CpuOptions } from "@opencae/solver-cpu";
import type { CloudAnalysisType, CloudStudyLike, CoreVolumeMeshArtifact } from "./types";

type BuildCoreModelInput = {
  study?: CloudStudyLike;
  displayModel?: unknown;
  volumeMesh: CoreVolumeMeshArtifact;
  material?: IsotropicLinearElasticMaterialJson | Record<string, unknown>;
  materials?: Array<IsotropicLinearElasticMaterialJson | Record<string, unknown>>;
  analysisType: CloudAnalysisType;
  solverSettings?: DynamicTet4CpuOptions & Record<string, unknown>;
};

type SelectionMappingInput = {
  study?: CloudStudyLike;
  displayModel?: unknown;
  volumeMesh: CoreVolumeMeshArtifact;
  selectionRef: string;
  role: "fixed_support" | "load_surface";
};

const STANDARD_GRAVITY = 9.80665;

const BUILT_IN_MATERIALS: Record<string, IsotropicLinearElasticMaterialJson> = {
  "mat-aluminum-6061": {
    name: "mat-aluminum-6061",
    type: "isotropicLinearElastic",
    youngModulus: 68_900_000_000,
    poissonRatio: 0.33,
    density: 2700,
    yieldStrength: 276_000_000
  },
  "mat-steel": {
    name: "mat-steel",
    type: "isotropicLinearElastic",
    youngModulus: 200_000_000_000,
    poissonRatio: 0.29,
    density: 7850,
    yieldStrength: 250_000_000
  }
};

export function buildCoreModelFromCloudMesh(input: BuildCoreModelInput): OpenCAEModelJson {
  validateVolumeMeshArtifact(input.volumeMesh);
  const material = resolveMaterial(input);
  const elementBlocks = [{
    name: "solid",
    type: input.volumeMesh.elements[0]?.type ?? "Tet4",
    material: material.name,
    connectivity: input.volumeMesh.elements.flatMap((element) => element.connectivity)
  }];
  const elementCount = input.volumeMesh.elements.length;
  const surfaceSets = cloneSurfaceSets(input.volumeMesh.surfaceSets);
  const nodeSets: NodeSetJson[] = [];
  const boundaryConditions: BoundaryConditionJson[] = [];
  const loads: LoadJson[] = [];

  for (const [index, constraint] of (input.study?.constraints ?? []).entries()) {
    if (constraint.type !== "fixed") continue;
    const selectionRef = constraint.selectionRef ?? "FS1";
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef,
      role: "fixed_support"
    }, surfaceSets);
    const nodeSetName = `${surfaceSet.name}_nodes`;
    nodeSets.push({ name: nodeSetName, nodes: nodeSetFromSurfaceSet(surfaceSet, input.volumeMesh.surfaceFacets) });
    boundaryConditions.push({
      name: `fixedSupport${index}`,
      type: "fixed",
      nodeSet: nodeSetName,
      components: ["x", "y", "z"]
    });
  }

  for (const [index, load] of (input.study?.loads ?? []).entries()) {
    const loadType = load.type ?? "force";
    if (loadType === "gravity" && !load.selectionRef) {
      loads.push({
        name: `bodyGravity${index}`,
        type: "bodyGravity",
        acceleration: gravityAcceleration(load.parameters)
      });
      continue;
    }

    const selectionRef = load.selectionRef ?? "L1";
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef,
      role: "load_surface"
    }, surfaceSets);

    if (loadType === "pressure") {
      loads.push({
        name: `pressure${index}`,
        type: "pressure",
        surfaceSet: surfaceSet.name,
        pressure: pressurePascals(load.parameters),
        direction: vector3(load.parameters?.direction) ?? [0, 0, -1]
      });
      continue;
    }

    loads.push({
      name: loadType === "gravity" ? `payloadGravity${index}` : `appliedForce${index}`,
      type: "surfaceForce",
      surfaceSet: surfaceSet.name,
      totalForce: loadType === "gravity" ? payloadGravityForce(load.parameters) : forceVector(load.parameters)
    });
  }

  if (boundaryConditions.length === 0) {
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef: "FS1",
      role: "fixed_support"
    }, surfaceSets);
    const nodeSetName = `${surfaceSet.name}_nodes`;
    nodeSets.push({ name: nodeSetName, nodes: nodeSetFromSurfaceSet(surfaceSet, input.volumeMesh.surfaceFacets) });
    boundaryConditions.push({ name: "fixedSupport0", type: "fixed", nodeSet: nodeSetName, components: ["x", "y", "z"] });
  }
  if (loads.length === 0) {
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef: "L1",
      role: "load_surface"
    }, surfaceSets);
    loads.push({ name: "appliedForce0", type: "surfaceForce", surfaceSet: surfaceSet.name, totalForce: [0, -500, 0] });
  }

  const model: OpenCAEModelJson = {
    schema: OPENCAE_MODEL_SCHEMA,
    schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
    nodes: { coordinates: [...input.volumeMesh.nodes.coordinates] },
    materials: [material],
    elementBlocks,
    nodeSets,
    elementSets: [{ name: "allElements", elements: Array.from({ length: elementCount }, (_value, index) => index) }],
    surfaceFacets: input.volumeMesh.surfaceFacets.map((facet) => ({ ...facet, nodes: [...facet.nodes] })),
    surfaceSets,
    boundaryConditions,
    loads,
    steps: [stepFor(input.analysisType, input.study, input.solverSettings, boundaryConditions, loads)],
    coordinateSystem: input.volumeMesh.coordinateSystem,
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: input.volumeMesh.metadata.source === "structured_block" ? "structured_block_core" : "actual_volume_mesh"
    }
  };
  const validation = validateModelJson(model);
  if (!validation.ok) {
    throw new Error(`OpenCAE Core Cloud generated an invalid Core model: ${validation.errors[0]?.message ?? "validation failed"}`);
  }
  const preflight = preflightCoreModel(model, { requireSurfaceSelections: true });
  if (!preflight.ok) {
    throw new Error(`OpenCAE Core Cloud model preflight failed: ${preflight.errors[0]?.message ?? "preflight failed"}`);
  }
  return model;
}

export function mapSelectionToSurfaceSet(input: SelectionMappingInput): SurfaceSetJson {
  const facets = input.volumeMesh.surfaceFacets;
  const bySelection = facets.filter((facet) => facet.sourceSelectionRef === input.selectionRef);
  const bySelectionSet = bestSurfaceSetForFacets(input.volumeMesh.surfaceSets, bySelection);
  if (bySelectionSet) return bySelectionSet;

  const sourceFaceIds = new Set([input.selectionRef, ...geometryRefEntityIds(input.study, input.selectionRef)]);
  const byFace = facets.filter((facet) => facet.sourceFaceId && sourceFaceIds.has(facet.sourceFaceId));
  const byFaceSet = bestSurfaceSetForFacets(input.volumeMesh.surfaceSets, byFace);
  if (byFaceSet) return byFaceSet;

  const selectionNames = new Set([
    input.selectionRef,
    ...selectionDisplayNames(input.study, input.selectionRef),
    ...sourceFaceIds
  ].map(normalizeName));
  const physicalNames = physicalGroupCandidates(input.role);
  const byPhysical = input.volumeMesh.surfaceSets.find((set) => physicalNames.has(set.name) && selectionNames.has(normalizeName(set.name)));
  if (byPhysical?.facets.length) return byPhysical;

  const geometric = geometricFallback(input);
  if (geometric) return geometric;

  throw new Error(`OpenCAE Core Cloud could not map selection ${input.selectionRef} to a high-confidence ${input.role} surface set.`);
}

function validateVolumeMeshArtifact(volumeMesh: CoreVolumeMeshArtifact): void {
  if (volumeMesh.elements.length === 0) throw new Error("Cloud meshing produced no volume elements.");
  if (volumeMesh.surfaceFacets.length === 0) throw new Error("Cloud meshing produced no boundary surface facets.");
  if (volumeMesh.metadata.connectedComponentCount !== 1) {
    throw new Error(`Cloud meshing produced ${volumeMesh.metadata.connectedComponentCount} connected components; one fused solid is required.`);
  }
  if (volumeMesh.metadata.meshQuality.invertedElementCount > 0) {
    throw new Error(`Cloud meshing produced ${volumeMesh.metadata.meshQuality.invertedElementCount} inverted elements.`);
  }
}

function resolveMaterial(input: BuildCoreModelInput): IsotropicLinearElasticMaterialJson {
  const candidates = [
    input.material,
    ...(input.materials ?? []),
    ...((input.study?.materialAssignments ?? []).map((assignment) => assignment.materialId).filter(Boolean) as string[])
  ];
  for (const candidate of candidates) {
    const material = materialFromUnknown(candidate);
    if (material) return material;
  }
  return { ...BUILT_IN_MATERIALS["mat-aluminum-6061"]! };
}

function materialFromUnknown(value: unknown): IsotropicLinearElasticMaterialJson | undefined {
  if (typeof value === "string") {
    const material = BUILT_IN_MATERIALS[value];
    if (!material) throw new Error(`OpenCAE Core Cloud does not know material ${value}.`);
    return { ...material };
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : typeof raw.id === "string" ? raw.id : "material";
  const youngModulus = numberValue(raw.youngModulus ?? raw.youngsModulus);
  const poissonRatio = numberValue(raw.poissonRatio);
  const density = numberValue(raw.density);
  const yieldStrength = numberValue(raw.yieldStrength);
  if (!youngModulus || poissonRatio === undefined || !density || !yieldStrength) return undefined;
  return {
    name,
    type: "isotropicLinearElastic",
    youngModulus,
    poissonRatio,
    density,
    yieldStrength
  };
}

function ensureMappedSurfaceSet(input: SelectionMappingInput, surfaceSets: SurfaceSetJson[]): SurfaceSetJson {
  const mapped = mapSelectionToSurfaceSet(input);
  const existing = surfaceSets.find((set) => set.name === mapped.name);
  if (existing) return existing;
  surfaceSets.push(mapped);
  return mapped;
}

function cloneSurfaceSets(surfaceSets: SurfaceSetJson[]): SurfaceSetJson[] {
  return surfaceSets.map((set) => ({ name: set.name, facets: [...set.facets] }));
}

function bestSurfaceSetForFacets(surfaceSets: SurfaceSetJson[], facets: SurfaceFacetJson[]): SurfaceSetJson | undefined {
  if (facets.length === 0) return undefined;
  const facetIds = new Set(facets.map((facet) => facet.id));
  const ranked = surfaceSets
    .map((set) => ({
      set,
      matches: set.facets.filter((facet) => facetIds.has(facet)).length
    }))
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches);
  return ranked[0]?.set;
}

function geometryRefEntityIds(study: CloudStudyLike | undefined, selectionRef: string): string[] {
  const selection = study?.namedSelections?.find((candidate) => candidate.id === selectionRef);
  return selection?.geometryRefs?.map((ref) => ref.entityId).filter((value): value is string => typeof value === "string") ?? [];
}

function selectionDisplayNames(study: CloudStudyLike | undefined, selectionRef: string): string[] {
  const selection = study?.namedSelections?.find((candidate) => candidate.id === selectionRef);
  return [selection?.name].filter((value): value is string => typeof value === "string");
}

function physicalGroupCandidates(role: SelectionMappingInput["role"]): Set<string> {
  return role === "fixed_support"
    ? new Set(["fixed_support", "base_mount", "fixed", "support"])
    : new Set(["load_surface", "upright_load", "load", "force"]);
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function geometricFallback(input: SelectionMappingInput): SurfaceSetJson | undefined {
  const displayFaces = displayModelFaces(input.displayModel);
  const entityIds = new Set([input.selectionRef, ...geometryRefEntityIds(input.study, input.selectionRef)]);
  const face = displayFaces.find((candidate) => entityIds.has(candidate.id));
  if (!face) return undefined;
  const ranked = input.volumeMesh.surfaceSets
    .map((set) => ({ set, score: geometricScore(set, input.volumeMesh.surfaceFacets, face) }))
    .filter((entry) => entry.score >= 0.9)
    .sort((left, right) => right.score - left.score);
  if (ranked.length !== 1) return undefined;
  return ranked[0]!.set;
}

function displayModelFaces(displayModel: unknown): Array<{ id: string; center?: [number, number, number]; normal?: [number, number, number] }> {
  if (!displayModel || typeof displayModel !== "object") return [];
  const faces = (displayModel as { faces?: unknown }).faces;
  if (!Array.isArray(faces)) return [];
  return faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const raw = face as { id?: unknown; center?: unknown; normal?: unknown };
    return typeof raw.id === "string" ? [{ id: raw.id, center: vector3(raw.center), normal: vector3(raw.normal) }] : [];
  });
}

function geometricScore(surfaceSet: SurfaceSetJson, facets: SurfaceFacetJson[], face: { center?: [number, number, number]; normal?: [number, number, number] }): number {
  const selected = facets.filter((facet) => surfaceSet.facets.includes(facet.id));
  if (selected.length === 0) return 0;
  const centroid = average(selected.map((facet) => facet.center).filter((value): value is [number, number, number] => Array.isArray(value)));
  const normal = average(selected.map((facet) => facet.normal).filter((value): value is [number, number, number] => Array.isArray(value)));
  const normalScore = face.normal && normal ? Math.max(0, dot(normalize(normal), normalize(face.normal))) : 0.5;
  const distanceScore = face.center && centroid ? Math.max(0, 1 - Math.hypot(centroid[0] - face.center[0], centroid[1] - face.center[1], centroid[2] - face.center[2]) / 0.02) : 0.5;
  return normalScore * 0.6 + distanceScore * 0.4;
}

function stepFor(
  analysisType: CloudAnalysisType,
  study: CloudStudyLike | undefined,
  solverSettings: (DynamicTet4CpuOptions & Record<string, unknown>) | undefined,
  boundaryConditions: BoundaryConditionJson[],
  loads: LoadJson[]
): StepJson {
  const names = {
    boundaryConditions: boundaryConditions.map((condition) => condition.name),
    loads: loads.map((load) => load.name)
  };
  if (analysisType === "static_stress") {
    return { name: "loadStep", type: "staticLinear", ...names };
  }
  const settings = { ...(study?.solverSettings ?? {}), ...(solverSettings ?? {}) };
  return {
    name: "dynamicStep",
    type: "dynamicLinear",
    ...names,
    startTime: numberValue(settings.startTime) ?? 0,
    endTime: numberValue(settings.endTime) ?? 0.1,
    timeStep: numberValue(settings.timeStep) ?? 0.005,
    outputInterval: numberValue(settings.outputInterval) ?? 0.005,
    loadProfile: dynamicLoadProfile(settings.loadProfile),
    dampingRatio: numberValue(settings.dampingRatio) ?? 0.02,
    ...(numberValue(settings.rayleighAlpha) !== undefined ? { rayleighAlpha: numberValue(settings.rayleighAlpha) } : {}),
    ...(numberValue(settings.rayleighBeta) !== undefined ? { rayleighBeta: numberValue(settings.rayleighBeta) } : {})
  };
}

function forceVector(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  const value = numberValue(parameters?.value) ?? 0;
  return [direction[0] * value, direction[1] * value, direction[2] * value];
}

function pressurePascals(parameters: Record<string, unknown> | undefined): number {
  const value = numberValue(parameters?.value) ?? 0;
  const units = typeof parameters?.units === "string" ? parameters.units.toLowerCase() : "pa";
  if (units === "kpa") return value * 1000;
  if (units === "mpa") return value * 1_000_000;
  if (units === "psi") return value * 6894.757293168;
  return value;
}

function payloadGravityForce(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  const massKg = numberValue(parameters?.value) ?? numberValue(parameters?.payloadMassKg) ?? 0;
  return [direction[0] * massKg * STANDARD_GRAVITY, direction[1] * massKg * STANDARD_GRAVITY, direction[2] * massKg * STANDARD_GRAVITY];
}

function gravityAcceleration(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  return [direction[0] * STANDARD_GRAVITY, direction[1] * STANDARD_GRAVITY, direction[2] * STANDARD_GRAVITY];
}

function dynamicLoadProfile(value: unknown): "step" | "ramp" | "quasi_static" | "half_sine" {
  if (value === "step" || value === "ramp" || value === "quasi_static" || value === "half_sine") return value;
  if (value === "quasiStatic") return "quasi_static";
  if (value === "sinusoidal") return "half_sine";
  return "ramp";
}

function vector3(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!]
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, -1, 0];
}

function average(values: Array<[number, number, number]>): [number, number, number] | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce<[number, number, number]>((acc, value) => [acc[0] + value[0], acc[1] + value[1], acc[2] + value[2]], [0, 0, 0]);
  return [sum[0] / values.length, sum[1] / values.length, sum[2] / values.length];
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}
