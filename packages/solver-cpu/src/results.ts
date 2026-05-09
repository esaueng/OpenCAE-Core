import {
  createCoreResultField,
  solverSurfaceMeshFromModel,
  type CoreResultField,
  type CoreSolveProvenance,
  type CoreSolveResult,
  type NormalizedOpenCAEModel,
  type SolverSurfaceMesh
} from "@opencae/core";
import { recoverNodalVonMisesFromElements } from "./element";
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
  const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, result.displacement);
  const surfaceVonMises = surfaceNodeScalars(
    surfaceMesh,
    recoverNodalVonMisesFromElements(model, result.vonMises, { surfaceOnly: true })
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
  const resultDiagnostics: unknown[] = [{ ...diagnostics }];
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
  for (const frame of result.frames) {
    const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, frame.displacement.values);
    const surfaceVelocity = surfaceVectorMagnitudes(surfaceMesh, frame.velocity.values);
    const surfaceAcceleration = surfaceVectorMagnitudes(surfaceMesh, frame.acceleration.values);
    const surfaceVonMises = surfaceNodeScalars(
      surfaceMesh,
      recoverNodalVonMisesFromElements(model, frame.vonMises.values, { surfaceOnly: true })
    );
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
    diagnostics: [{ ...diagnostics }],
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
