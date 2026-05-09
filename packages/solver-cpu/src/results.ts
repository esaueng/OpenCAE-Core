import {
  assembleNodalLoadVectorWithDiagnostics,
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
import { recoverNodalVonMisesFromElements } from "./recovery";
import type { DynamicTet4CpuResult, DynamicTet4CpuDiagnostics, StaticLinearTet4CpuResult, CpuSolverDiagnostics } from "./types";

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
  const displacementScale = lengthToMmScale(model);
  const stressScale = stressToMpaScale(model);
  const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, result.displacement, displacementScale);
  const surfaceDisplacementVectors = surfaceNodeVectors(surfaceMesh, result.displacement, displacementScale);
  const recoveredNodalVonMises = recoverNodalVonMisesFromElements(model, result.vonMises);
  const surfaceVonMises = surfaceNodeScalars(
    surfaceMesh,
    recoveredNodalVonMises,
    stressScale
  );
  const displacementSurfaceField = createCoreResultField({
    id: "displacement-surface",
    type: "displacement",
    location: "node",
    values: surfaceDisplacement,
    vectors: surfaceDisplacementVectors,
    units: "mm",
    surfaceMeshRef: surfaceMesh.id,
    visualizationSource: "surface_displacement_vector"
  });
  const stressSurfaceField = createCoreResultField({
    id: "stress-surface",
    type: "stress",
    location: "node",
    values: surfaceVonMises,
    units: "MPa",
    surfaceMeshRef: surfaceMesh.id,
    visualizationSource: "volume_weighted_nodal_recovery",
    engineeringSource: "raw_element_von_mises"
  });
  const fields: CoreResultField[] = [
    displacementSurfaceField,
    stressSurfaceField,
    createCoreResultField({
      id: "stress-von-mises-element",
      type: "stress",
      location: "element",
      values: result.vonMises,
      units: stressUnits(model),
      meshRef: "solver-volume",
      engineeringSource: "raw_element_von_mises"
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
        engineeringSource: "raw_element_von_mises"
      })
    );
  }

  const minSafetyFactor = positiveMin(safetyFactor);
  const stressDiagnostic = stressVisualizationDiagnostic(
    model,
    surfaceMesh,
    stressSurfaceField,
    displacementSurfaceField,
    result.reactionForce,
    maxAbs(result.vonMises) * stressScale
  );
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
  let latestSurfaceDisplacement: number[] = [];
  let latestStressSurfaceField: CoreResultField | undefined;
  let latestDisplacementSurfaceField: CoreResultField | undefined;
  const displacementScale = lengthToMmScale(model);
  const stressScale = stressToMpaScale(model);
  for (const frame of result.frames) {
    const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, frame.displacement.values, displacementScale);
    const surfaceDisplacementVectors = surfaceNodeVectors(surfaceMesh, frame.displacement.values, displacementScale);
    const surfaceVelocity = surfaceVectorMagnitudes(surfaceMesh, frame.velocity.values, displacementScale);
    const surfaceAcceleration = surfaceVectorMagnitudes(surfaceMesh, frame.acceleration.values, displacementScale);
    const recoveredNodalVonMises = recoverNodalVonMisesFromElements(model, frame.vonMises.values);
    const surfaceVonMises = surfaceNodeScalars(
      surfaceMesh,
      recoveredNodalVonMises,
      stressScale
    );
    latestSurfaceVonMises = surfaceVonMises;
    latestSurfaceDisplacement = surfaceDisplacement;
    const displacementSurfaceField = createCoreResultField({
      id: `frame-${frame.frameIndex}-displacement-surface`,
      type: "displacement",
      location: "node",
      values: surfaceDisplacement,
      vectors: surfaceDisplacementVectors,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id,
      frameIndex: frame.frameIndex,
      timeSeconds: frame.timeSeconds,
      visualizationSource: "surface_displacement_vector"
    });
    const stressSurfaceField = createCoreResultField({
      id: `frame-${frame.frameIndex}-stress-surface`,
      type: "stress",
      location: "node",
      values: surfaceVonMises,
      units: "MPa",
      surfaceMeshRef: surfaceMesh.id,
      frameIndex: frame.frameIndex,
      timeSeconds: frame.timeSeconds,
      visualizationSource: "volume_weighted_nodal_recovery",
      engineeringSource: "raw_element_von_mises"
    });
    latestDisplacementSurfaceField = displacementSurfaceField;
    latestStressSurfaceField = stressSurfaceField;
    fields.push(
      displacementSurfaceField,
      createCoreResultField({
        id: `frame-${frame.frameIndex}-velocity`,
        type: "velocity",
        location: "node",
        values: surfaceVelocity,
        units: "mm/s",
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
        units: "mm/s^2",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_acceleration_magnitude"
      }),
      stressSurfaceField,
      createCoreResultField({
        id: `frame-${frame.frameIndex}-stress-von-mises-element`,
        type: "stress",
        location: "element",
        values: frame.vonMises.values,
        units: stressUnits(model),
        meshRef: "solver-volume",
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        engineeringSource: "raw_element_von_mises"
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
          engineeringSource: "raw_element_von_mises"
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
        latestStressSurfaceField ?? createCoreResultField({
          id: "stress-surface-empty",
          type: "stress",
          location: "node",
          values: latestSurfaceVonMises,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id,
          visualizationSource: "volume_weighted_nodal_recovery",
          engineeringSource: "raw_element_von_mises"
        }),
        latestDisplacementSurfaceField ?? createCoreResultField({
          id: "displacement-surface-empty",
          type: "displacement",
          location: "node",
          values: latestSurfaceDisplacement,
          units: "mm",
          surfaceMeshRef: surfaceMesh.id,
          visualizationSource: "surface_displacement_vector"
        }),
        result.frames.at(-1)?.reactionForce,
        diagnostics.maxVonMisesStress * stressScale
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

function stressToMpaScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1 : 1 / 1_000_000;
}

function surfaceVectorMagnitudes(surfaceMesh: SolverSurfaceMesh, vector: Float64Array, scale: number): number[] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    const [x, y, z] = vectorComponentsForVolumeNode(vector, volumeNode, surfaceNode, "vector");
    return Math.hypot(x, y, z) * scale;
  });
}

function surfaceNodeVectors(
  surfaceMesh: SolverSurfaceMesh,
  vector: Float64Array,
  scale: number
): [number, number, number][] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    const [x, y, z] = vectorComponentsForVolumeNode(vector, volumeNode, surfaceNode, "vector");
    return [
      x * scale,
      y * scale,
      z * scale
    ];
  });
}

function surfaceNodeScalars(surfaceMesh: SolverSurfaceMesh, nodalValues: Float64Array, scale: number): number[] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    assertValidSurfaceVolumeNode(surfaceMesh, volumeNode, surfaceNode);
    const value = nodalValues[volumeNode];
    if (!Number.isFinite(value)) {
      throw new Error(`Surface scalar field cannot read volume node ${volumeNode} for surface node ${surfaceNode}.`);
    }
    return value * scale;
  });
}

function vectorComponentsForVolumeNode(
  vector: Float64Array,
  volumeNode: number,
  surfaceNode: number,
  fieldName: string
): [number, number, number] {
  if (!Number.isInteger(volumeNode) || volumeNode < 0) {
    throw new Error(`Surface ${fieldName} field references invalid volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
  const offset = volumeNode * 3;
  if (offset + 2 >= vector.length) {
    throw new Error(`Surface ${fieldName} field cannot read volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
  const components: [number, number, number] = [vector[offset], vector[offset + 1], vector[offset + 2]];
  if (!components.every(Number.isFinite)) {
    throw new Error(`Surface ${fieldName} field read non-finite vector components for volume node ${volumeNode}.`);
  }
  return components;
}

function assertValidSurfaceVolumeNode(surfaceMesh: SolverSurfaceMesh, volumeNode: number, surfaceNode: number): void {
  const volumeNodeCount = surfaceMesh.volumeNodeCount;
  if (
    !Number.isInteger(volumeNode) ||
    volumeNode < 0 ||
    (volumeNodeCount !== undefined && volumeNode >= volumeNodeCount)
  ) {
    throw new Error(`Surface field references invalid volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
}

type NodeSelectionSummary = {
  count: number;
  centroid: [number, number, number];
};

type StressBeamAxisBin = {
  bin: number;
  xCenter: number;
  meanStress: number;
  maxStress: number;
  nodeCount: number;
};

function stressVisualizationDiagnostic(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  stressField: CoreResultField,
  displacementField: CoreResultField,
  reactionForce: Float64Array | undefined,
  engineeringStressMaxMpa: number
): {
  id: "stress-visualization";
  engineeringStressMaxMpa: number;
  plotStressMinMpa: number;
  plotStressMaxMpa: number;
  stressFieldLocation: CoreResultField["location"];
  surfaceMeshRef: string | undefined;
  visualizationSource: string | undefined;
  stressRecoveryMethod: "volume_weighted_nodal_recovery";
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  stressFieldValueCount: number;
  displacementFieldValueCount: number;
  fieldSurfaceAlignment: "ok";
  fixedNodeCount: number;
  loadNodeCount: number;
  appliedLoadVector: [number, number, number];
  reactionVector: [number, number, number];
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
  stressByBeamAxisBin: StressBeamAxisBin[];
  warnings: string[];
} {
  const activeStep = firstStructuralStep(model);
  const fixedSelection = nodeSelectionForBoundaryConditions(model, activeStep?.boundaryConditions ?? []);
  const loadSelection = nodeSelectionForLoads(model, activeStep?.loads ?? []);
  const stressByBeamAxisBin = stressBinsByBeamAxis(model, surfaceMesh, stressField.values, 20);
  const warnings = stressVisualizationWarnings(model, stressByBeamAxisBin, fixedSelection, loadSelection);
  return {
    id: "stress-visualization",
    engineeringStressMaxMpa,
    plotStressMinMpa: stressField.values.length > 0 ? Math.min(...stressField.values) : 0,
    plotStressMaxMpa: stressField.values.length > 0 ? Math.max(...stressField.values) : 0,
    stressFieldLocation: stressField.location,
    surfaceMeshRef: stressField.surfaceMeshRef,
    visualizationSource: stressField.visualizationSource,
    stressRecoveryMethod: "volume_weighted_nodal_recovery",
    surfaceNodeCount: surfaceMesh.nodes.length,
    surfaceTriangleCount: surfaceMesh.triangles.length,
    stressFieldValueCount: stressField.values.length,
    displacementFieldValueCount: displacementField.values.length,
    fieldSurfaceAlignment: "ok",
    fixedNodeCount: fixedSelection.count,
    loadNodeCount: loadSelection.count,
    appliedLoadVector: activeStep ? appliedLoadVectorForStep(model, activeStep.loads) : [0, 0, 0],
    reactionVector: vectorSum(reactionForce),
    fixedCentroid: fixedSelection.centroid,
    loadCentroid: loadSelection.centroid,
    effectiveLeverArmMm: distance(fixedSelection.centroid, loadSelection.centroid) * lengthToMmScale(model),
    stressByBeamAxisBin,
    warnings
  };
}

function firstStructuralStep(model: NormalizedOpenCAEModel): { boundaryConditions: string[]; loads: string[] } | undefined {
  return model.steps.find((step) => step.type === "staticLinear" || step.type === "dynamicLinear");
}

function nodeSelectionForBoundaryConditions(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]): NodeSelectionSummary {
  const active = new Set(boundaryConditionNames);
  const nodeSetNames = new Set<string>();
  for (const boundaryCondition of model.boundaryConditions) {
    if (active.has(boundaryCondition.name) && isFixedBoundaryCondition(boundaryCondition)) {
      nodeSetNames.add(boundaryCondition.nodeSet);
    }
  }
  const nodeIds = new Set<number>();
  for (const nodeSetName of nodeSetNames) addNodeSetNodes(model, nodeSetName, nodeIds);
  return nodeSelectionSummary(model, nodeIds);
}

function nodeSelectionForLoads(model: NormalizedOpenCAEModel, loadNames: string[]): NodeSelectionSummary {
  const active = new Set(loadNames);
  const nodeIds = new Set<number>();
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    addLoadNodes(model, load, nodeIds);
  }
  return nodeSelectionSummary(model, nodeIds);
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

function addNodeSetNodes(model: NormalizedOpenCAEModel, nodeSetName: string, nodeIds: Set<number>): void {
  const nodeSet = model.nodeSets.find((candidate) => candidate.name === nodeSetName);
  if (!nodeSet) return;
  for (const node of nodeSet.nodes) nodeIds.add(node);
}

function nodeSelectionSummary(model: NormalizedOpenCAEModel, nodeIds: Set<number>): NodeSelectionSummary {
  if (nodeIds.size === 0) {
    return { count: 0, centroid: [0, 0, 0] };
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const node of nodeIds) {
    x += modelCoordinateAt(model, node, 0);
    y += modelCoordinateAt(model, node, 1);
    z += modelCoordinateAt(model, node, 2);
  }
  return { count: nodeIds.size, centroid: [x / nodeIds.size, y / nodeIds.size, z / nodeIds.size] };
}

function isFixedBoundaryCondition(boundaryCondition: BoundaryConditionJson): boolean {
  return boundaryCondition.type === "fixed";
}

function appliedLoadVectorForStep(model: NormalizedOpenCAEModel, loadNames: string[]): [number, number, number] {
  return assembleNodalLoadVectorWithDiagnostics(model, loadNames).diagnostics.totalAppliedForce;
}

function stressBinsByBeamAxis(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  binCount: number
): StressBeamAxisBin[] {
  const bounds = modelBounds(model);
  const axis = dominantBoundsAxis(bounds);
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const span = max - min;
  const count = Math.max(1, Math.floor(binCount));
  const bins = Array.from({ length: count }, (_value, bin) => ({
    bin,
    xCenter: span > 0 ? min + ((bin + 0.5) / count) * span : min,
    sum: 0,
    maxStress: Number.NEGATIVE_INFINITY,
    nodeCount: 0
  }));

  for (let index = 0; index < surfaceMesh.nodes.length; index += 1) {
    const node = surfaceMesh.nodes[index];
    const value = values[index];
    if (!node || !Number.isFinite(value)) continue;
    const station = span > 0 ? (node[axis] - min) / span : 0;
    const bin = Math.max(0, Math.min(count - 1, Math.floor(station * count)));
    const target = bins[bin];
    target.sum += value;
    target.maxStress = Math.max(target.maxStress, value);
    target.nodeCount += 1;
  }

  return bins.map((bin) => ({
    bin: bin.bin,
    xCenter: bin.xCenter,
    meanStress: bin.nodeCount > 0 ? bin.sum / bin.nodeCount : 0,
    maxStress: bin.nodeCount > 0 ? bin.maxStress : 0,
    nodeCount: bin.nodeCount
  }));
}

function stressVisualizationWarnings(
  model: NormalizedOpenCAEModel,
  bins: StressBeamAxisBin[],
  fixedSelection: NodeSelectionSummary,
  loadSelection: NodeSelectionSummary
): string[] {
  const warnings: string[] = [];
  if (hasAbruptStressDiscontinuity(bins)) {
    warnings.push("Stress field has an abrupt spatial discontinuity; verify surface node mapping and load/support selection.");
  }
  if (loadSupportMappingLooksSuspicious(model, fixedSelection, loadSelection)) {
    warnings.push("Load/support mapping does not match expected end-face selection.");
  }
  return warnings;
}

function hasAbruptStressDiscontinuity(bins: StressBeamAxisBin[]): boolean {
  const populated = bins.filter((bin) => bin.nodeCount > 0);
  if (populated.length < 4) return false;
  const means = populated.map((bin) => bin.meanStress);
  const min = Math.min(...means);
  const max = Math.max(...means);
  const range = max - min;
  if (!Number.isFinite(range) || range <= 1e-9) return false;
  let largestJump = 0;
  for (let index = 1; index < means.length; index += 1) {
    largestJump = Math.max(largestJump, Math.abs(means[index] - means[index - 1]));
  }
  return largestJump / range > 0.9;
}

function loadSupportMappingLooksSuspicious(
  model: NormalizedOpenCAEModel,
  fixedSelection: NodeSelectionSummary,
  loadSelection: NodeSelectionSummary
): boolean {
  if (fixedSelection.count === 0 || loadSelection.count === 0) return false;
  const bounds = modelBounds(model);
  const axis = dominantBoundsAxis(bounds);
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-12) return false;
  const fixedStation = fixedSelection.centroid[axis];
  const loadStation = loadSelection.centroid[axis];
  if (Math.abs(loadStation - fixedStation) < span * 0.4) return true;
  const fixedEndDistance = Math.min(Math.abs(fixedStation - min), Math.abs(fixedStation - max));
  const loadEndDistance = Math.min(Math.abs(loadStation - min), Math.abs(loadStation - max));
  return fixedEndDistance > span * 0.25 || loadEndDistance > span * 0.25;
}

function modelBounds(model: NormalizedOpenCAEModel): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let node = 0; node < model.counts.nodes; node += 1) {
    for (const axis of [0, 1, 2] as const) {
      const coordinate = modelCoordinateAt(model, node, axis);
      min[axis] = Math.min(min[axis], coordinate);
      max[axis] = Math.max(max[axis], coordinate);
    }
  }
  return { min, max };
}

function dominantBoundsAxis(bounds: { min: [number, number, number]; max: [number, number, number] }): 0 | 1 | 2 {
  const spans: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
  return spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
}

function modelCoordinateAt(model: NormalizedOpenCAEModel, node: number, axis: 0 | 1 | 2): number {
  const value = model.nodes.coordinates[node * 3 + axis];
  if (!Number.isFinite(value)) {
    throw new Error(`Model node ${node} has non-finite coordinate ${axis}.`);
  }
  return value;
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
  const sum = vectorSum(values);
  return Math.hypot(sum[0], sum[1], sum[2]);
}

function vectorSum(values: Float64Array | undefined): [number, number, number] {
  if (!values) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < values.length; index += 3) {
    x += values[index];
    y += values[index + 1];
    z += values[index + 2];
  }
  return [x, y, z];
}

function positiveMin(values: Float64Array): number | undefined {
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value > 0 && Number.isFinite(value)) min = Math.min(min, value);
  }
  return Number.isFinite(min) ? min : undefined;
}
