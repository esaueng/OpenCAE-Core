import {
  assembleNodalLoadVectorWithDiagnostics,
  normalizeModelJson,
  type NormalizedElementBlock,
  type NormalizedOpenCAEModel,
  type NormalizedTet4ElementBlock,
} from "@opencae/core";
import { collectTetCoordinates, recoverStress, recoverTet4Strain } from "./element";
import { computeTet4ElementStiffness, computeTet4Geometry, computeVonMisesStress } from "./element";
import { solveDenseLinearSystem } from "./linear-solve";
import { computeLinearElasticDMatrix } from "./material";
import { staticCoreResultFromSolve } from "./results";
import {
  addSparseEntry,
  conjugateGradient,
  createSparseMatrixBuilder,
  csrMatVec,
  reduceCsrSystem,
  toCsrMatrix,
  type CsrMatrix,
  type SparseMatrixBuilder
} from "./sparse";
import type {
  CpuSolverDiagnostics,
  CpuSolverError,
  CpuSolverInput,
  CpuSolverOptions,
  StaticLinearTet4CpuResult,
  StaticLinearTet4CpuSolveResult
} from "./types";

const COMPONENT_INDEX = {
  x: 0,
  y: 1,
  z: 2
} as const;

export function solveStaticLinearTet4Cpu(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): StaticLinearTet4CpuSolveResult {
  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) {
    return {
      ok: false,
      error: modelResult.error
    };
  }

  const model = modelResult.model;
  const dofs = model.counts.nodes * 3;
  const maxDofs = options.maxDofs ?? 30000;
  if (dofs > maxDofs) {
    return failure("max-dofs-exceeded", `Model has ${dofs} DOFs, which exceeds maxDofs ${maxDofs}.`, {
      dofs
    });
  }

  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "staticLinear") {
    return failure("invalid-step", "Selected step must exist and have type staticLinear.", { dofs });
  }

  const constraints = collectConstraints(model, step.boundaryConditions);
  if (!constraints.ok) {
    return failure(constraints.error.code, constraints.error.message, { dofs });
  }

  const constrainedDofs = constraints.values.size;
  const freeDofs = dofs - constrainedDofs;
  if (freeDofs <= 0) {
    return failure("no-free-dofs", "Model has no free DOFs to solve.", {
      dofs,
      constrainedDofs,
      freeDofs
    });
  }

  const free = enumerateFreeDofs(dofs, constraints.values);
  const loadAssembly = assembleNodalForcesWithDiagnostics(model, step.loads);
  if (!loadAssembly.ok) {
    return failure(loadAssembly.error.code, loadAssembly.error.message, {
      dofs,
      constrainedDofs,
      freeDofs
    });
  }
  const loads = loadAssembly.forces;
  const solverMode = selectSolverMode(dofs, options, model, step.loads);

  if (solverMode === "dense") {
    const assembly = assembleDenseStiffness(model);
    if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
    return solveDenseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
  }

  const assembly = assembleSparseStiffness(model);
  if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
  return solveSparseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
}

export function solveStaticLinearTet(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): StaticLinearTet4CpuSolveResult {
  const method = options.method ?? options.solverMode ?? "auto";
  return solveStaticLinearTet4Cpu(input, {
    ...options,
    solverMode: method
  });
}

export function getNormalizedModel(input: CpuSolverInput):
  | { ok: true; model: NormalizedOpenCAEModel }
  | { ok: false; error: CpuSolverError } {
  if (isNormalizedModel(input)) {
    return { ok: true, model: input };
  }

  const result = normalizeModelJson(input);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "validation-failed",
        message: "Input model failed OpenCAE Core validation.",
        report: result.report
      }
    };
  }

  return { ok: true, model: result.model };
}

export function assembleDenseStiffness(model: NormalizedOpenCAEModel):
  | { ok: true; stiffness: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const dofs = model.counts.nodes * 3;
  const stiffness = new Float64Array(dofs * dofs);

  const elementAssembly = assembleElementStiffnesses(model, {
    add(block, elementOffset, elementStiffness) {
      scatterDenseElementStiffness(stiffness, dofs, block, elementOffset, elementStiffness);
    }
  });
  if (!elementAssembly.ok) return elementAssembly;

  return { ok: true, stiffness };
}

export function assembleSparseStiffness(model: NormalizedOpenCAEModel):
  | { ok: true; stiffness: CsrMatrix }
  | { ok: false; error: CpuSolverError } {
  const dofs = model.counts.nodes * 3;
  const builder = createSparseMatrixBuilder(dofs);

  const elementAssembly = assembleElementStiffnesses(model, {
    add(block, elementOffset, elementStiffness) {
      scatterSparseElementStiffness(builder, block, elementOffset, elementStiffness);
    }
  });
  if (!elementAssembly.ok) return elementAssembly;

  return { ok: true, stiffness: toCsrMatrix(builder) };
}

export function assembleNodalForces(model: NormalizedOpenCAEModel, loadNames: string[]): Float64Array {
  const result = assembleNodalForcesWithDiagnostics(model, loadNames);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.forces;
}

function assembleNodalForcesWithDiagnostics(model: NormalizedOpenCAEModel, loadNames: string[]):
  | { ok: true; forces: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const result = assembleNodalLoadVectorWithDiagnostics(model, loadNames);
  if (result.diagnostics.errors.length > 0) {
    const firstError = result.diagnostics.errors[0];
    return {
      ok: false,
      error: {
        code: firstError.code,
        message: result.diagnostics.errors.map((error) => error.message).join("; ")
      }
    };
  }
  return { ok: true, forces: result.vector };
}

export function collectConstraints(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]):
  | { ok: true; values: Map<number, number> }
  | { ok: false; error: CpuSolverError } {
  const values = new Map<number, number>();
  const activeBoundaryConditions = new Set(boundaryConditionNames);
  const nodeSets = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));

  for (const boundaryCondition of model.boundaryConditions) {
    if (!activeBoundaryConditions.has(boundaryCondition.name)) {
      continue;
    }
    const nodes = nodeSets.get(boundaryCondition.nodeSet);
    if (!nodes) {
      continue;
    }

    if (boundaryCondition.type === "fixed") {
      for (const component of boundaryCondition.components) {
        for (const node of nodes) {
          const conflict = setConstraint(values, node * 3 + COMPONENT_INDEX[component], 0);
          if (conflict) return conflict;
        }
      }
    } else {
      for (const node of nodes) {
        const conflict = setConstraint(
          values,
          node * 3 + COMPONENT_INDEX[boundaryCondition.component],
          boundaryCondition.value
        );
        if (conflict) return conflict;
      }
    }
  }

  return { ok: true, values };
}

export function enumerateFreeDofs(dofs: number, constraints: Map<number, number>): Int32Array {
  const free = new Int32Array(dofs - constraints.size);
  let freeIndex = 0;
  for (let dof = 0; dof < dofs; dof += 1) {
    if (!constraints.has(dof)) {
      free[freeIndex] = dof;
      freeIndex += 1;
    }
  }
  return free;
}

function solveDenseSystem(
  model: NormalizedOpenCAEModel,
  stiffness: Float64Array,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  options: CpuSolverOptions
): StaticLinearTet4CpuSolveResult {
  const dofs = model.counts.nodes * 3;
  const freeDofs = free.length;
  const singularTolerance = options.singularTolerance ?? 1e-12;
  const kff = new Float64Array(freeDofs * freeDofs);
  const rhs = new Float64Array(freeDofs);
  for (let rowIndex = 0; rowIndex < freeDofs; rowIndex += 1) {
    const rowDof = free[rowIndex];
    rhs[rowIndex] = loads[rowDof];
    for (const [constrainedDof, value] of constraints) {
      rhs[rowIndex] -= stiffness[rowDof * dofs + constrainedDof] * value;
    }
    for (let colIndex = 0; colIndex < freeDofs; colIndex += 1) {
      kff[rowIndex * freeDofs + colIndex] = stiffness[rowDof * dofs + free[colIndex]];
    }
  }

  const solve = solveDenseLinearSystem(kff, rhs, singularTolerance);
  if (!solve.ok) {
    return failure(solve.error.code, solve.error.message, {
      dofs,
      constrainedDofs: constraints.size,
      freeDofs,
      solverMode: "dense"
    });
  }

  return finishSolve(model, loads, constraints, free, solve.solution, multiplyDenseMatrixVector(stiffness, dofs), {
    solverMode: "dense",
    iterations: freeDofs,
    converged: true
  });
}

function solveSparseSystem(
  model: NormalizedOpenCAEModel,
  stiffness: CsrMatrix,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  options: CpuSolverOptions
): StaticLinearTet4CpuSolveResult {
  const reduced = reduceCsrSystem(stiffness, loads, free, constraints);
  const solve = conjugateGradient(reduced.matrix, reduced.rhs, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations,
    jacobi: true
  });
  if (!solve.ok) {
    return failure(solve.error.code, solve.error.message, {
      dofs: model.counts.nodes * 3,
      constrainedDofs: constraints.size,
      freeDofs: free.length,
      relativeResidual: solve.relativeResidual,
      solverMode: "sparse",
      iterations: solve.iterations,
      converged: false
    });
  }

  return finishSolve(model, loads, constraints, free, solve.solution, (displacement) => csrMatVec(stiffness, displacement), {
    solverMode: "sparse",
    iterations: solve.iterations,
    converged: true
  });
}

function finishSolve(
  model: NormalizedOpenCAEModel,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  freeSolution: Float64Array,
  multiplyFull: (displacement: Float64Array) => Float64Array,
  diagnostics: Pick<CpuSolverDiagnostics, "solverMode" | "iterations" | "converged">
): StaticLinearTet4CpuSolveResult {
  const dofs = model.counts.nodes * 3;
  const displacement = new Float64Array(dofs);
  for (const [dof, value] of constraints) displacement[dof] = value;
  for (let i = 0; i < free.length; i += 1) displacement[free[i]] = freeSolution[i];

  const internalForce = multiplyFull(displacement);
  const reactionForce = new Float64Array(dofs);
  for (let i = 0; i < dofs; i += 1) reactionForce[i] = internalForce[i] - loads[i];

  const relativeResidual = computeRelativeResidual(internalForce, loads, free);
  const recovery = recoverElementResults(model, displacement);
  if (!recovery.ok) {
    return failure(recovery.error.code, recovery.error.message, {
      dofs,
      constrainedDofs: constraints.size,
      freeDofs: free.length,
      relativeResidual,
      ...diagnostics
    });
  }

  const result: StaticLinearTet4CpuResult = {
    displacement,
    reactionForce,
    strain: recovery.strain,
    stress: recovery.stress,
    vonMises: recovery.vonMises,
    provenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      resultSource: "computed",
      meshSource: model.meshProvenance?.meshSource === "actual_volume_mesh" ? "actual_volume_mesh" : "structured_block"
    }
  };

  const fullDiagnostics = {
    dofs,
    freeDofs: free.length,
    constrainedDofs: constraints.size,
    relativeResidual,
    maxDisplacement: maxNodeVectorNorm(displacement),
    maxVonMisesStress: maxAbs(recovery.vonMises),
    ...diagnostics
  };
  result.coreResult = staticCoreResultFromSolve(model, result, fullDiagnostics);

  return {
    ok: true,
    result,
    diagnostics: fullDiagnostics
  };
}

function assembleElementStiffnesses(
  model: NormalizedOpenCAEModel,
  scatter: {
    add(block: NormalizedTet4ElementBlock, elementOffset: number, stiffness: Float64Array): void;
  }
): { ok: true } | { ok: false; error: CpuSolverError } {
  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") {
      return {
        ok: false,
        error: {
          code: "unsupported-element-type",
          message: "CPU reference solver currently supports Tet4 elements. Tet10 is schema-valid but not solved yet."
        }
      };
    }
    const tet4Block = block as NormalizedTet4ElementBlock;
    const material = model.materials[block.materialIndex];
    if (!material || material.type !== "isotropicLinearElastic") {
      return {
        ok: false,
        error: {
          code: "unsupported-model",
          message: "CPU reference solver supports isotropicLinearElastic materials."
        }
      };
    }

    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < tet4Block.connectivity.length; elementOffset += 4) {
      const coordinates = collectTetCoordinates(model.nodes.coordinates, tet4Block.connectivity, elementOffset);
      const geometry = computeTet4Geometry(coordinates);
      if (!geometry.ok) return geometry;
      const elementStiffness = computeTet4ElementStiffness(geometry, d);
      if (!elementStiffness.ok) return elementStiffness;
      scatter.add(tet4Block, elementOffset, elementStiffness.stiffness);
    }
  }
  return { ok: true };
}

function scatterDenseElementStiffness(
  global: Float64Array,
  dofs: number,
  block: NormalizedElementBlock,
  elementOffset: number,
  element: Float64Array
): void {
  for (let localRowNode = 0; localRowNode < 4; localRowNode += 1) {
    const rowNode = block.connectivity[elementOffset + localRowNode];
    for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
      const globalRow = rowNode * 3 + rowComponent;
      const localRow = localRowNode * 3 + rowComponent;
      for (let localColNode = 0; localColNode < 4; localColNode += 1) {
        const colNode = block.connectivity[elementOffset + localColNode];
        for (let colComponent = 0; colComponent < 3; colComponent += 1) {
          const globalCol = colNode * 3 + colComponent;
          const localCol = localColNode * 3 + colComponent;
          global[globalRow * dofs + globalCol] += element[localRow * 12 + localCol];
        }
      }
    }
  }
}

function scatterSparseElementStiffness(
  builder: SparseMatrixBuilder,
  block: NormalizedElementBlock,
  elementOffset: number,
  element: Float64Array
): void {
  for (let localRowNode = 0; localRowNode < 4; localRowNode += 1) {
    const rowNode = block.connectivity[elementOffset + localRowNode];
    for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
      const globalRow = rowNode * 3 + rowComponent;
      const localRow = localRowNode * 3 + rowComponent;
      for (let localColNode = 0; localColNode < 4; localColNode += 1) {
        const colNode = block.connectivity[elementOffset + localColNode];
        for (let colComponent = 0; colComponent < 3; colComponent += 1) {
          const globalCol = colNode * 3 + colComponent;
          const localCol = localColNode * 3 + colComponent;
          addSparseEntry(builder, globalRow, globalCol, element[localRow * 12 + localCol]);
        }
      }
    }
  }
}

function setConstraint(
  values: Map<number, number>,
  dof: number,
  value: number
): { ok: false; error: CpuSolverError } | undefined {
  const existing = values.get(dof);
  if (existing !== undefined && Math.abs(existing - value) > 1e-12) {
    return {
      ok: false,
      error: {
        code: "conflicting-prescribed-displacement",
        message: "A constrained DOF has conflicting prescribed displacement values."
      }
    };
  }
  values.set(dof, value);
  return undefined;
}

export function recoverElementResults(model: NormalizedOpenCAEModel, displacement: Float64Array):
  | { ok: true; strain: Float64Array; stress: Float64Array; vonMises: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const strain = new Float64Array(model.counts.elements * 6);
  const stress = new Float64Array(model.counts.elements * 6);
  const vonMises = new Float64Array(model.counts.elements);
  let globalElement = 0;

  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") {
      return {
        ok: false,
        error: {
          code: "unsupported-element-type",
          message: "CPU reference solver currently supports Tet4 elements. Tet10 is schema-valid but not solved yet."
        }
      };
    }
    const material = model.materials[block.materialIndex];
    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += 4) {
      const geometry = computeTet4Geometry(
        collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset)
      );
      if (!geometry.ok) return geometry;

      const elementDisplacement = new Float64Array(12);
      for (let localNode = 0; localNode < 4; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        elementDisplacement[localNode * 3] = displacement[node * 3];
        elementDisplacement[localNode * 3 + 1] = displacement[node * 3 + 1];
        elementDisplacement[localNode * 3 + 2] = displacement[node * 3 + 2];
      }

      const elementStrain = recoverTet4Strain(geometry.gradients, elementDisplacement);
      const elementStress = recoverStress(d, elementStrain);
      strain.set(elementStrain, globalElement * 6);
      stress.set(elementStress, globalElement * 6);
      vonMises[globalElement] = computeVonMisesStress(elementStress);
      globalElement += 1;
    }
  }

  return { ok: true, strain, stress, vonMises };
}

function multiplyDenseMatrixVector(matrix: Float64Array, size: number): (vector: Float64Array) => Float64Array {
  return (vector) => {
    const result = new Float64Array(size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        result[row] += matrix[row * size + col] * vector[col];
      }
    }
    return result;
  };
}

function computeRelativeResidual(
  internalForce: Float64Array,
  externalForce: Float64Array,
  free: Int32Array
): number {
  let residualNormSquared = 0;
  let referenceNormSquared = 0;
  for (let i = 0; i < free.length; i += 1) {
    const residual = internalForce[free[i]] - externalForce[free[i]];
    residualNormSquared += residual * residual;
    referenceNormSquared += externalForce[free[i]] * externalForce[free[i]];
  }
  const residualNorm = Math.sqrt(residualNormSquared);
  const reference = Math.sqrt(referenceNormSquared);
  return reference === 0 && residualNorm === 0 ? 0 : residualNorm / Math.max(reference, 1);
}

export function maxNodeVectorNorm(displacement: Float64Array): number {
  let max = 0;
  for (let node = 0; node < displacement.length / 3; node += 1) {
    const ux = displacement[node * 3];
    const uy = displacement[node * 3 + 1];
    const uz = displacement[node * 3 + 2];
    max = Math.max(max, Math.sqrt(ux * ux + uy * uy + uz * uz));
  }
  return max;
}

export function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function selectSolverMode(
  dofs: number,
  options: CpuSolverOptions,
  model: NormalizedOpenCAEModel,
  activeLoadNames: string[]
): "dense" | "sparse" {
  if (options.solverMode === "dense" || options.solverMode === "sparse") return options.solverMode;
  if (activeLoadsRequireSparse(model, activeLoadNames)) return "sparse";
  return dofs <= 300 ? "dense" : "sparse";
}

function activeLoadsRequireSparse(model: NormalizedOpenCAEModel, activeLoadNames: string[]): boolean {
  const active = new Set(activeLoadNames);
  return model.loads.some((load) => active.has(load.name) && (load.type === "surfaceForce" || load.type === "pressure"));
}

function failure(
  code: string,
  message: string,
  diagnostics?: Partial<CpuSolverDiagnostics>
): StaticLinearTet4CpuSolveResult {
  return {
    ok: false,
    error: { code, message },
    diagnostics
  };
}

function isNormalizedModel(input: CpuSolverInput): input is NormalizedOpenCAEModel {
  return (
    typeof input === "object" &&
    input !== null &&
    "nodes" in input &&
    input.nodes.coordinates instanceof Float64Array &&
    "counts" in input
  );
}
