import { extractBoundarySurfaceFacets } from "./mesh";
import type {
  ElementBlockJson,
  MeshProvenanceJson,
  NormalizedOpenCAEModel,
  OpenCAEModelJson,
  SurfaceFacetJson
} from "./model-json";

export type SolverSurfaceMesh = {
  id: string;
  nodes: [number, number, number][];
  triangles: [number, number, number][];
  coordinateSpace: "solver" | "display_model";
  source: "opencae_core_volume_mesh";
};

export type CoreResultField = {
  id: string;
  type: "stress" | "displacement" | "velocity" | "acceleration" | "safety_factor";
  location: "node" | "element" | "integration_point";
  values: number[];
  min: number;
  max: number;
  units: string;
  meshRef?: string;
  frameIndex?: number;
  timeSeconds?: number;
};

export type CoreTransientSummary = {
  frameCount: number;
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  loadProfile?: string;
  peakVelocity?: number;
  peakAcceleration?: number;
};

export type CoreSolveSummary = {
  maxStress: number;
  maxDisplacement: number;
  safetyFactor?: number;
  reactionForce?: number;
  transient?: CoreTransientSummary;
};

export type CoreSolveResult = {
  summary: CoreSolveSummary;
  fields: CoreResultField[];
  surfaceMesh?: SolverSurfaceMesh;
  diagnostics: Record<string, unknown>;
  provenance: MeshProvenanceJson;
};

export type CoreResultValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type CoreResultValidationReport = {
  ok: boolean;
  errors: CoreResultValidationIssue[];
  warnings: CoreResultValidationIssue[];
};

type ResultModel = Pick<OpenCAEModelJson, "nodes" | "elementBlocks" | "coordinateSystem"> & {
  surfaceFacets?: Array<SurfaceFacetJson | { id: number; nodes: ArrayLike<number> }>;
};

export function solverSurfaceMeshFromModel(
  model: OpenCAEModelJson | NormalizedOpenCAEModel,
  id = "solver-surface"
): SolverSurfaceMesh {
  const coordinates = model.nodes.coordinates;
  const facets = collectSurfaceFacets(model);
  const surfaceNodeByVolumeNode = new Map<number, number>();
  const nodes: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];

  for (const facet of facets) {
    if (facet.nodes.length < 3) continue;
    const triangle = [facet.nodes[0], facet.nodes[1], facet.nodes[2]].map((volumeNode) => {
      const existing = surfaceNodeByVolumeNode.get(volumeNode);
      if (existing !== undefined) return existing;
      const surfaceNode = nodes.length;
      surfaceNodeByVolumeNode.set(volumeNode, surfaceNode);
      nodes.push([
        coordinates[volumeNode * 3] ?? 0,
        coordinates[volumeNode * 3 + 1] ?? 0,
        coordinates[volumeNode * 3 + 2] ?? 0
      ]);
      return surfaceNode;
    });
    triangles.push(triangle as [number, number, number]);
  }

  return {
    id,
    nodes,
    triangles,
    coordinateSpace: model.coordinateSystem?.renderCoordinateSpace ?? "solver",
    source: "opencae_core_volume_mesh"
  };
}

export function createCoreResultField(
  field: Omit<CoreResultField, "values" | "min" | "max"> & { values: ArrayLike<number> }
): CoreResultField {
  const values = Array.from(field.values);
  const finiteValues = values.filter(Number.isFinite);
  return {
    ...field,
    values,
    min: finiteValues.length > 0 ? Math.min(...finiteValues) : 0,
    max: finiteValues.length > 0 ? Math.max(...finiteValues) : 0
  };
}

export function validateCoreResult(result: CoreSolveResult): CoreResultValidationReport {
  const errors: CoreResultValidationIssue[] = [];
  validateSummary(result.summary, errors);

  if (!Array.isArray(result.fields) || result.fields.length === 0) {
    errors.push(issue("empty-fields", "Core result must contain at least one field.", "fields"));
  } else {
    result.fields.forEach((field, index) => validateField(field, index, errors));
  }

  if (result.surfaceMesh) validateSurfaceMesh(result.surfaceMesh, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

function collectSurfaceFacets(model: OpenCAEModelJson | NormalizedOpenCAEModel): SurfaceFacetJson[] {
  if (model.surfaceFacets && model.surfaceFacets.length > 0) {
    return model.surfaceFacets.map((facet) => ({
      ...facet,
      nodes: Array.from(facet.nodes)
    })) as SurfaceFacetJson[];
  }

  return extractBoundarySurfaceFacets({
    nodes: {
      coordinates: Array.from(model.nodes.coordinates)
    },
    elementBlocks: model.elementBlocks.map((block) => ({
      name: block.name,
      type: block.type,
      material: block.material,
      connectivity: Array.from(block.connectivity)
    })) as ElementBlockJson[]
  });
}

function validateSummary(summary: CoreSolveSummary, errors: CoreResultValidationIssue[]): void {
  if (!Number.isFinite(summary.maxStress)) {
    errors.push(issue("non-finite-summary", "Summary maxStress must be finite.", "summary.maxStress"));
  }
  if (!Number.isFinite(summary.maxDisplacement)) {
    errors.push(issue("non-finite-summary", "Summary maxDisplacement must be finite.", "summary.maxDisplacement"));
  }
  if (summary.safetyFactor !== undefined && !Number.isFinite(summary.safetyFactor)) {
    errors.push(issue("non-finite-summary", "Summary safetyFactor must be finite when present.", "summary.safetyFactor"));
  }
  if (summary.reactionForce !== undefined && !Number.isFinite(summary.reactionForce)) {
    errors.push(issue("non-finite-summary", "Summary reactionForce must be finite when present.", "summary.reactionForce"));
  }
}

function validateField(field: CoreResultField, index: number, errors: CoreResultValidationIssue[]): void {
  const path = `fields[${index}]`;
  if (!Array.isArray(field.values) || field.values.length === 0) {
    errors.push(issue("empty-field-values", "Core result field values must be non-empty.", `${path}.values`));
  }
  field.values.forEach((value, valueIndex) => {
    if (!Number.isFinite(value)) {
      errors.push(issue("non-finite-field-value", "Core result field values must be finite.", `${path}.values[${valueIndex}]`));
    }
  });
  if (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max) {
    errors.push(issue("invalid-field-range", "Core result field min/max must be finite and ordered.", path));
  }
  if (field.values.length > 0 && field.values.every(Number.isFinite)) {
    const actualMin = Math.min(...field.values);
    const actualMax = Math.max(...field.values);
    if (field.min > actualMin + 1e-12 || field.max < actualMax - 1e-12) {
      errors.push(issue("invalid-field-range", "Core result field min/max must enclose field values.", path));
    }
  }
  if (requiresFrameMetadata(field) && (!Number.isInteger(field.frameIndex) || !Number.isFinite(field.timeSeconds))) {
    errors.push(issue("missing-frame-metadata", "Dynamic Core result fields must include frameIndex and timeSeconds.", path));
  }
}

function validateSurfaceMesh(surfaceMesh: SolverSurfaceMesh, errors: CoreResultValidationIssue[]): void {
  surfaceMesh.nodes.forEach((node, nodeIndex) => {
    for (let component = 0; component < 3; component += 1) {
      if (!Number.isFinite(node[component])) {
        errors.push(issue("non-finite-surface-node", "Surface mesh node coordinates must be finite.", `surfaceMesh.nodes[${nodeIndex}]`));
      }
    }
  });
  surfaceMesh.triangles.forEach((triangle, triangleIndex) => {
    for (const node of triangle) {
      if (!Number.isInteger(node) || node < 0 || node >= surfaceMesh.nodes.length) {
        errors.push(
          issue(
            "invalid-surface-triangle-node",
            "Surface mesh triangle references a missing surface node.",
            `surfaceMesh.triangles[${triangleIndex}]`
          )
        );
      }
    }
  });
}

function requiresFrameMetadata(field: CoreResultField): boolean {
  return (
    field.type === "velocity" ||
    field.type === "acceleration" ||
    field.frameIndex !== undefined ||
    field.timeSeconds !== undefined
  );
}

function issue(code: string, message: string, path: string): CoreResultValidationIssue {
  return { code, message, path };
}
