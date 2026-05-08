import {
  normalizeModelJson,
  type LoadJson,
  type NormalizedElementBlock,
  type NormalizedOpenCAEModel,
  type NormalizedSurfaceFacet,
  type NormalizedTet4ElementBlock,
} from "@opencae/core";
import { collectTetCoordinates, recoverStress, recoverTet4Strain } from "./element";
import { computeTet4ElementStiffness, computeTet4Geometry, computeVonMisesStress } from "./element";
import { solveDenseLinearSystem } from "./linear-solve";
import { computeLinearElasticDMatrix } from "./material";
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
  const loads = assembleNodalForces(model, step.loads);
  const solverMode = selectSolverMode(dofs, options);

  if (solverMode === "dense") {
    const assembly = assembleDenseStiffness(model);
    if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
    return solveDenseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
  }

  const assembly = assembleSparseStiffness(model);
  if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
  return solveSparseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
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
  const forces = new Float64Array(model.counts.nodes * 3);
  const activeLoads = new Set(loadNames);
  const nodeSets = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));
  const surfaceSets = new Map(model.surfaceSets.map((surfaceSet) => [surfaceSet.name, surfaceSet.facets]));
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));

  for (const load of model.loads) {
    if (!activeLoads.has(load.name)) continue;
    if (load.type === "nodalForce") {
      const nodes = nodeSets.get(load.nodeSet);
      if (!nodes) continue;
      for (const node of nodes) {
        forces[node * 3] += load.vector[0];
        forces[node * 3 + 1] += load.vector[1];
        forces[node * 3 + 2] += load.vector[2];
      }
      continue;
    }

    const facetIds = surfaceSets.get(load.surfaceSet);
    if (!facetIds || facetIds.length === 0) continue;
    if (load.type === "surfaceForce") {
      distributeSurfaceForce(model, forces, load, facetIds, facets);
    } else {
      distributePressure(model, forces, load, facetIds, facets);
    }
  }
  return forces;
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

  return {
    ok: true,
    result: {
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
    },
    diagnostics: {
      dofs,
      freeDofs: free.length,
      constrainedDofs: constraints.size,
      relativeResidual,
      maxDisplacement: maxNodeVectorNorm(displacement),
      maxVonMisesStress: maxAbs(recovery.vonMises),
      ...diagnostics
    }
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

function distributeSurfaceForce(
  model: NormalizedOpenCAEModel,
  forces: Float64Array,
  load: Extract<LoadJson, { type: "surfaceForce" }>,
  facetIds: Uint32Array,
  facets: Map<number, NormalizedSurfaceFacet>
): void {
  const selected = Array.from(facetIds, (id) => facets.get(id)).filter((facet): facet is NormalizedSurfaceFacet => !!facet);
  const totalArea = selected.reduce((sum, facet) => sum + facetArea(model, facet), 0);
  if (totalArea <= 0) return;
  for (const facet of selected) {
    const areaWeight = facetArea(model, facet) / totalArea;
    const contribution: [number, number, number] = [
      load.totalForce[0] * areaWeight,
      load.totalForce[1] * areaWeight,
      load.totalForce[2] * areaWeight
    ];
    distributeFacetForce(forces, facet, contribution);
  }
}

function distributePressure(
  model: NormalizedOpenCAEModel,
  forces: Float64Array,
  load: Extract<LoadJson, { type: "pressure" }>,
  facetIds: Uint32Array,
  facets: Map<number, NormalizedSurfaceFacet>
): void {
  for (const facetId of facetIds) {
    const facet = facets.get(facetId);
    if (!facet) continue;
    const area = facetArea(model, facet);
    const direction = normalizeVector(load.direction ?? facet.normal ?? [0, 0, 0]);
    distributeFacetForce(forces, facet, [
      direction[0] * load.pressure * area,
      direction[1] * load.pressure * area,
      direction[2] * load.pressure * area
    ]);
  }
}

function distributeFacetForce(
  forces: Float64Array,
  facet: NormalizedSurfaceFacet,
  force: [number, number, number]
): void {
  const nodes = Array.from(facet.nodes).slice(0, 3);
  if (nodes.length === 0) return;
  for (const node of nodes) {
    forces[node * 3] += force[0] / nodes.length;
    forces[node * 3 + 1] += force[1] / nodes.length;
    forces[node * 3 + 2] += force[2] / nodes.length;
  }
}

function facetArea(model: NormalizedOpenCAEModel, facet: NormalizedSurfaceFacet): number {
  if (facet.area && facet.area > 0) return facet.area;
  const nodes = Array.from(facet.nodes);
  const a = nodeCoordinates(model, nodes[0]);
  const b = nodeCoordinates(model, nodes[1]);
  const c = nodeCoordinates(model, nodes[2]);
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function nodeCoordinates(model: NormalizedOpenCAEModel, node: number): [number, number, number] {
  return [
    model.nodes.coordinates[node * 3],
    model.nodes.coordinates[node * 3 + 1],
    model.nodes.coordinates[node * 3 + 2]
  ];
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

function normalizeVector(vector: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

function selectSolverMode(dofs: number, options: CpuSolverOptions): "dense" | "sparse" {
  if (options.solverMode === "dense" || options.solverMode === "sparse") return options.solverMode;
  return dofs <= 300 ? "dense" : "sparse";
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
