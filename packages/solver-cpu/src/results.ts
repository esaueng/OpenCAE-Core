import {
  createCoreResultField,
  solverSurfaceMeshFromModel,
  type CoreResultField,
  type CoreSolveProvenance,
  type CoreSolveResult,
  type NormalizedOpenCAEModel
} from "@opencae/core";
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
  const fields: CoreResultField[] = [
    createCoreResultField({
      id: "displacement",
      type: "displacement",
      location: "node",
      values: result.displacement,
      units: displacementUnits(model),
      meshRef: surfaceMesh.id
    }),
    createCoreResultField({
      id: "stress-von-mises",
      type: "stress",
      location: "element",
      values: result.vonMises,
      units: stressUnits(model),
      meshRef: surfaceMesh.id
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
        meshRef: surfaceMesh.id
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
    fields.push(
      createCoreResultField({
        id: `frame-${frame.frameIndex}-displacement`,
        type: "displacement",
        location: "node",
        values: frame.displacement.values,
        units: displacementUnits(model),
        meshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-velocity`,
        type: "velocity",
        location: "node",
        values: frame.velocity.values,
        units: `${displacementUnits(model)}/s`,
        meshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-acceleration`,
        type: "acceleration",
        location: "node",
        values: frame.acceleration.values,
        units: `${displacementUnits(model)}/s^2`,
        meshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-stress-von-mises`,
        type: "stress",
        location: "element",
        values: frame.vonMises.values,
        units: stressUnits(model),
        meshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds
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
          meshRef: surfaceMesh.id,
          frameIndex: frame.frameIndex,
          timeSeconds: frame.timeSeconds
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
  return {
    kind: "opencae_core_fea",
    solver,
    resultSource: "computed",
    meshSource: model.meshProvenance?.meshSource === "structured_block" ? "structured_block_core" : "actual_volume_mesh",
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
