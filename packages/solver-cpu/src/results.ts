import {
  createCoreResultField,
  solverSurfaceMeshFromModel,
  type BoundaryConditionJson,
  type CoreResultField,
  type CoreSolveProvenance,
  type CoreSolveResult,
  type LoadJson,
  type NormalizedOpenCAEModel,
  type SolverSurfaceMesh
} from "@opencae/core";
import { recoverNodalVonMisesFromElements, smoothNodalScalarField } from "./element";
import type { DynamicTet4CpuResult, DynamicTet4CpuDiagnostics, StaticLinearTet4CpuResult, CpuSolverDiagnostics } from "./types";

const VISUALIZATION_SMOOTHING_ITERATIONS = 1;

export function staticCoreResultFromSolve(
  model: NormalizedOpenCAEModel,
  result: StaticLinearTet4CpuResult,
  diagnostics: CpuSolverDiagnostics
): CoreSolveResult {
  const surfaceMesh = solverSurfaceMeshFromModel(model);
  const safetyFactor = computeSafetyFactor(model, result.vonMises);
  const provenance = coreProvenance(model, "opencae-core-sparse-tet");
  const maxDisplacement = maxNodeVectorNorm(result.displacement);
  const reactionForce = vectorSumMagnitude(result.reactionForce);
  const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, result.displacement);
  const recoveredNodalVonMises = recoverNodalVonMisesFromElements(model, result.vonMises);
  const plotNodalVonMises = smoothNodalScalarField(model, recoveredNodalVonMises, VISUALIZATION_SMOOTHING_ITERATIONS);
  const surfaceVonMises = surfaceNodeScalars(
    surfaceMesh,
    plotNodalVonMises
  );
  const fields: CoreResultField[] = [
    createCoreResultField({
      id: "displacement-magnitude-surface",
      type: "displacement",
      location: "node",
      values: surfaceDisplacement,
      units: displacementUnits(model),
      surfaceMeshRef: surfaceMesh.id,
      visualizationSource: "surface_displacement_magnitude"
    }),
    createCoreResultField({
      id: "stress-von-mises-surface",
      type: "stress",
      location: "node",
      values: surfaceVonMises,
      units: stressUnits(model),
      surfaceMeshRef: surfaceMesh.id,
      visualizationSource: "nodal_recovered_surface_average",
      engineeringSource: "element_von_mises"
    }),
    createCoreResultField({
      id: "stress-von-mises-element",
      type: "stress",
      location: "element",
      values: result.vonMises,
      units: stressUnits(model),
      meshRef: "solver-volume",
      engineeringSource: "element_von_mises"
    })
  ];
  if (hasYieldStrength(model)) {
    fields.push(
      createCoreResultField({
        id: "safety-factor",
        type: "safety_factor",
        location: "element",
        values: safetyFactor,
        units: "ratio",
        meshRef: "solver-volume",
        engineeringSource: "element_von_mises"
      })
    );
  }

  const minSafetyFactor = positiveMin(safetyFactor);
  const stressDiagnostic = stressVisualizationDiagnostic(model, surfaceMesh, surfaceVonMises, maxAbs(result.vonMises));
  const resultDiagnostics: unknown[] = [{ ...diagnostics }, stressDiagnostic];
  if (maxDisplacement === 0 && reactionForce > 1e-12) {
    resultDiagnostics.push({
      id: "zero-displacement-nonzero-load",
      severity: "warning",
      source: "solver",
      message: "Displacement is exactly zero even though the solved reaction force is nonzero."
    });
  }
  return {
    summary: {
      maxStress: maxAbs(result.vonMises),
      maxStressUnits: stressUnits(model),
      maxDisplacement,
      maxDisplacementUnits: displacementUnits(model),
      safetyFactor: minSafetyFactor,
      reactionForce,
      reactionForceUnits: "N",
      provenance
    },
    fields,
    surfaceMesh,
    diagnostics: resultDiagnostics,
    provenance
  };
}

export function dynamicCoreResultFromSolve(
  model: NormalizedOpenCAEModel,
  result: DynamicTet4CpuResult,
  diagnostics: DynamicTet4CpuDiagnostics
): CoreSolveResult {
  const surfaceMesh = solverSurfaceMeshFromModel(model);
  const provenance = coreProvenance(model, "opencae-core-mdof-tet");
  const fields: CoreResultField[] = [];
  let latestSurfaceVonMises: number[] = [];
  for (const frame of result.frames) {
    const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, frame.displacement.values);
    const surfaceVelocity = surfaceVectorMagnitudes(surfaceMesh, frame.velocity.values);
    const surfaceAcceleration = surfaceVectorMagnitudes(surfaceMesh, frame.acceleration.values);
    const recoveredNodalVonMises = recoverNodalVonMisesFromElements(model, frame.vonMises.values);
    const plotNodalVonMises = smoothNodalScalarField(model, recoveredNodalVonMises, VISUALIZATION_SMOOTHING_ITERATIONS);
    const surfaceVonMises = surfaceNodeScalars(
      surfaceMesh,
      plotNodalVonMises
    );
    latestSurfaceVonMises = surfaceVonMises;
    fields.push(
      createCoreResultField({
        id: `frame-${frame.frameIndex}-displacement`,
        type: "displacement",
        location: "node",
        values: surfaceDisplacement,
        units: displacementUnits(model),
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_displacement_magnitude"
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-velocity`,
        type: "velocity",
        location: "node",
        values: surfaceVelocity,
        units: `${displacementUnits(model)}/s`,
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_velocity_magnitude"
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-acceleration`,
        type: "acceleration",
        location: "node",
        values: surfaceAcceleration,
        units: `${displacementUnits(model)}/s^2`,
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_acceleration_magnitude"
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-stress-von-mises-surface`,
        type: "stress",
        location: "node",
        values: surfaceVonMises,
        units: stressUnits(model),
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "nodal_recovered_surface_average",
        engineeringSource: "element_von_mises"
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-stress-von-mises-element`,
        type: "stress",
        location: "element",
        values: frame.vonMises.values,
        units: stressUnits(model),
        meshRef: "solver-volume",
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        engineeringSource: "element_von_mises"
      })
    );
    if (hasYieldStrength(model)) {
      fields.push(
        createCoreResultField({
          id: `frame-${frame.frameIndex}-safety-factor`,
          type: "safety_factor",
          location: "element",
          values: frame.safety_factor.values,
          units: "ratio",
          meshRef: "solver-volume",
          frameIndex: frame.frameIndex,
          timeSeconds: frame.timeSeconds,
          engineeringSource: "element_von_mises"
        })
      );
    }
  }

  return {
    summary: {
      maxStress: diagnostics.maxVonMisesStress,
      maxStressUnits: stressUnits(model),
      maxDisplacement: diagnostics.peakDisplacement,
      maxDisplacementUnits: displacementUnits(model),
      safetyFactor: diagnostics.minSafetyFactor,
      reactionForce: result.frames.length > 0 ? vectorSumMagnitude(result.frames.at(-1)?.reactionForce) : 0,
      reactionForceUnits: "N",
      provenance,
      transient: {
        frameCount: diagnostics.frameCount,
        analysisType: "dynamic_structural",
        startTime: diagnostics.startTime,
        endTime: diagnostics.endTime,
        timeStep: diagnostics.timeStep,
        outputInterval: diagnostics.outputInterval,
        loadProfile: diagnostics.loadProfile,
        peakDisplacement: diagnostics.peakDisplacement,
        peakDisplacementTimeSeconds: peakDisplacementTime(result),
        peakVelocity: diagnostics.peakVelocity,
        peakAcceleration: diagnostics.peakAcceleration
      }
    },
    fields,
    surfaceMesh,
    diagnostics: [
      { ...diagnostics },
      stressVisualizationDiagnostic(
        model,
        surfaceMesh,
        latestSurfaceVonMises,
        diagnostics.maxVonMisesStress
      )
    ],
    provenance
  };
}

function computeSafetyFactor(model: NormalizedOpenCAEModel, vonMises: Float64Array): Float64Array {
  const values = new Float64Array(vonMises.length);
  let element = 0;
  for (const block of model.elementBlocks) {
    const yieldStrength = model.materials[block.materialIndex]?.yieldStrength ?? 0;
    const elementNodeCount = block.type === "Tet10" ? 10 : 4;
    const elementCount = Math.floor(block.connectivity.length / elementNodeCount);
    for (let index = 0; index < elementCount; index += 1) {
      values[element] = yieldStrength > 0 && vonMises[element] > 0 ? yieldStrength / vonMises[element] : 0;
      element += 1;
    }
  }
  return values;
}

function hasYieldStrength(model: NormalizedOpenCAEModel): boolean {
  return model.materials.some((material) => (material.yieldStrength ?? 0) > 0);
}

function coreProvenance(
  model: NormalizedOpenCAEModel,
  solver: CoreSolveProvenance["solver"]
): CoreSolveProvenance {
  const meshSource = model.meshProvenance?.meshSource;
  return {
    kind: "opencae_core_fea",
    solver,
    resultSource: "computed",
    meshSource:
      meshSource === "structured_block" || meshSource === "structured_block_core"
        ? "structured_block_core"
        : "actual_volume_mesh",
    units: model.coordinateSystem.solverUnits
  };
}

function peakDisplacementTime(result: DynamicTet4CpuResult): number {
  let peak = -1;
  let time = 0;
  for (const frame of result.frames) {
    const value = maxNodeVectorNorm(frame.displacement.values);
    if (value > peak) {
      peak = value;
      time = frame.timeSeconds;
    }
  }
  return time;
}

function displacementUnits(model: NormalizedOpenCAEModel): string {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? "mm" : "m";
}

function stressUnits(model: NormalizedOpenCAEModel): string {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? "MPa" : "Pa";
}

function maxNodeVectorNorm(values: Float64Array): number {
  let max = 0;
  for (let node = 0; node < values.length / 3; node += 1) {
    max = Math.max(max, Math.hypot(values[node * 3], values[node * 3 + 1], values[node * 3 + 2]));
  }
  return max;
}

function surfaceVectorMagnitudes(surfaceMesh: SolverSurfaceMesh, vector: Float64Array): number[] {
  return (surfaceMesh.nodeMap ?? []).map((volumeNode) => {
    const offset = volumeNode * 3;
    return Math.hypot(vector[offset] ?? 0, vector[offset + 1] ?? 0, vector[offset + 2] ?? 0);
  });
}

function surfaceNodeScalars(surfaceMesh: SolverSurfaceMesh, nodalValues: Float64Array): number[] {
  return (surfaceMesh.nodeMap ?? []).map((volumeNode) => nodalValues[volumeNode] ?? 0);
}

function stressVisualizationDiagnostic(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  plotValues: number[],
  engineeringStressMax: number
): {
  id: "stress-visualization";
  engineeringStressMax: number;
  plotStressMin: number;
  plotStressMax: number;
  stressRecoveryMethod: "volume_weighted_nodal_average";
  smoothingIterations: number;
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  fieldValueCount: number;
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
} {
  const activeStep = firstStructuralStep(model);
  const fixedCentroid = centroidForBoundaryConditions(model, activeStep?.boundaryConditions ?? []);
  const loadCentroid = centroidForLoads(model, activeStep?.loads ?? []);
  return {
    id: "stress-visualization",
    engineeringStressMax,
    plotStressMin: plotValues.length > 0 ? Math.min(...plotValues) : 0,
    plotStressMax: plotValues.length > 0 ? Math.max(...plotValues) : 0,
    stressRecoveryMethod: "volume_weighted_nodal_average",
    smoothingIterations: VISUALIZATION_SMOOTHING_ITERATIONS,
    surfaceNodeCount: surfaceMesh.nodes.length,
    surfaceTriangleCount: surfaceMesh.triangles.length,
    fieldValueCount: plotValues.length,
    fixedCentroid,
    loadCentroid,
    effectiveLeverArmMm: distance(fixedCentroid, loadCentroid) * lengthToMmScale(model)
  };
}

function firstStructuralStep(model: NormalizedOpenCAEModel): { boundaryConditions: string[]; loads: string[] } | undefined {
  return model.steps.find((step) => step.type === "staticLinear" || step.type === "dynamicLinear");
}

function centroidForBoundaryConditions(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]): [number, number, number] {
  const active = new Set(boundaryConditionNames);
  const nodeSetNames = new Set<string>();
  for (const boundaryCondition of model.boundaryConditions) {
    if (active.has(boundaryCondition.name) && isFixedBoundaryCondition(boundaryCondition)) {
      nodeSetNames.add(boundaryCondition.nodeSet);
    }
  }
  return centroidForNodeSetNames(model, nodeSetNames);
}

function centroidForLoads(model: NormalizedOpenCAEModel, loadNames: string[]): [number, number, number] {
  const active = new Set(loadNames);
  const nodeIds = new Set<number>();
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    addLoadNodes(model, load, nodeIds);
  }
  return centroidForNodes(model, nodeIds);
}

function addLoadNodes(model: NormalizedOpenCAEModel, load: LoadJson, nodeIds: Set<number>): void {
  if (load.type === "nodalForce") {
    addNodeSetNodes(model, load.nodeSet, nodeIds);
    return;
  }
  if (load.type === "surfaceForce" || load.type === "pressure") {
    const surfaceSet = model.surfaceSets.find((set) => set.name === load.surfaceSet);
    if (!surfaceSet) return;
    const facetById = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
    for (const facetId of surfaceSet.facets) {
      const facet = facetById.get(facetId);
      if (!facet) continue;
      for (const node of facet.nodes) nodeIds.add(node);
    }
  }
}

function centroidForNodeSetNames(model: NormalizedOpenCAEModel, nodeSetNames: Set<string>): [number, number, number] {
  const nodeIds = new Set<number>();
  for (const nodeSetName of nodeSetNames) addNodeSetNodes(model, nodeSetName, nodeIds);
  return centroidForNodes(model, nodeIds);
}

function addNodeSetNodes(model: NormalizedOpenCAEModel, nodeSetName: string, nodeIds: Set<number>): void {
  const nodeSet = model.nodeSets.find((candidate) => candidate.name === nodeSetName);
  if (!nodeSet) return;
  for (const node of nodeSet.nodes) nodeIds.add(node);
}

function centroidForNodes(model: NormalizedOpenCAEModel, nodeIds: Set<number>): [number, number, number] {
  if (nodeIds.size === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const node of nodeIds) {
    x += model.nodes.coordinates[node * 3] ?? 0;
    y += model.nodes.coordinates[node * 3 + 1] ?? 0;
    z += model.nodes.coordinates[node * 3 + 2] ?? 0;
  }
  return [x / nodeIds.size, y / nodeIds.size, z / nodeIds.size];
}

function isFixedBoundaryCondition(boundaryCondition: BoundaryConditionJson): boolean {
  return boundaryCondition.type === "fixed";
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lengthToMmScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1 : 1000;
}

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function vectorSumMagnitude(values: Float64Array | undefined): number {
  if (!values) return 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < values.length; index += 3) {
    x += values[index];
    y += values[index + 1];
    z += values[index + 2];
  }
  return Math.hypot(x, y, z);
}

function positiveMin(values: Float64Array): number | undefined {
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value > 0 && Number.isFinite(value)) min = Math.min(min, value);
  }
  return Number.isFinite(min) ? min : undefined;
}
