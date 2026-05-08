import { type NormalizedOpenCAEModel } from "@opencae/core";
import { computeTet4Geometry } from "./geometry";
import {
  assembleNodalForces,
  assembleSparseStiffness,
  collectConstraints,
  enumerateFreeDofs,
  getNormalizedModel,
  maxAbs,
  recoverElementResults
} from "./solver";
import { addSparseEntry, conjugateGradient, createSparseMatrixBuilder, csrMatVec, reduceCsrSystem, toCsrMatrix, type CsrMatrix } from "./sparse";
import type {
  CpuSolverError,
  CpuSolverInput,
  DynamicLoadProfile,
  DynamicResultField,
  DynamicTet4CpuDiagnostics,
  DynamicTet4CpuFrame,
  DynamicTet4CpuOptions,
  DynamicTet4CpuSolveResult
} from "./types";

const DEFAULT_END_TIME_SECONDS = 0.1;
const DEFAULT_TIME_STEP_SECONDS = 0.005;
const DEFAULT_OUTPUT_INTERVAL_SECONDS = 0.005;
const DEFAULT_DAMPING_RATIO = 0.02;
const DEFAULT_MASS_DENSITY_KG_PER_M3 = 2700;

type DynamicSettings = Required<Pick<
  DynamicTet4CpuOptions,
  "startTime" | "endTime" | "timeStep" | "outputInterval" | "dampingRatio" | "loadProfile" | "massDensity"
>>;

type ReducedSystem = {
  stiffness: CsrMatrix;
  load: Float64Array;
  mass: Float64Array;
  free: Int32Array;
};

export function solveDynamicMdofTet4Cpu(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };
  const model = modelResult.model;
  const settings = dynamicSettings(model, options);
  if (settings.endTime <= settings.startTime) {
    return failure("invalid-time-range", "Dynamic solve endTime must be greater than startTime.");
  }

  const step = model.steps[options.stepIndex ?? 0];
  if (!step || (step.type !== "staticLinear" && step.type !== "dynamicLinear")) {
    return failure("invalid-step", "Selected dynamic step must be staticLinear or dynamicLinear.");
  }

  const stiffness = assembleSparseStiffness(model);
  if (!stiffness.ok) return { ok: false, error: stiffness.error };
  const constraints = collectConstraints(model, step.boundaryConditions);
  if (!constraints.ok) return { ok: false, error: constraints.error };
  const free = enumerateFreeDofs(model.counts.nodes * 3, constraints.values);
  const fullLoad = assembleNodalForces(model, step.loads);
  const reduced = reduceCsrSystem(stiffness.stiffness, fullLoad, free, constraints.values);
  const lumpedMass = assembleLumpedMass(model, settings.massDensity);
  const reducedMass = new Float64Array(free.length);
  for (let i = 0; i < free.length; i += 1) reducedMass[i] = Math.max(lumpedMass[free[i]], 1e-12);

  const system: ReducedSystem = {
    stiffness: reduced.matrix,
    load: reduced.rhs,
    mass: reducedMass,
    free
  };
  const rayleighAlpha = settings.dampingRatio > 0 ? settings.dampingRatio * 10 : 0;
  const rayleighBeta = settings.dampingRatio > 0 ? settings.dampingRatio * 1e-4 : 0;

  const frames: DynamicTet4CpuFrame[] = [];
  const u = new Float64Array(free.length);
  const v = new Float64Array(free.length);
  let a = initialAcceleration(system, settings, rayleighAlpha, rayleighBeta);
  let time = settings.startTime;
  let frameIndex = 0;
  let nextOutputTime = settings.startTime + settings.outputInterval;
  const pushFrame = (loadScale: number) => {
    frames.push(createFrame(model, free, u, v, a, frameIndex, round(time, 9), loadScale));
    frameIndex += 1;
  };
  pushFrame(loadScaleAt(time, settings));

  const maxSteps = Math.ceil((settings.endTime - settings.startTime) / settings.timeStep) + 2;
  for (let stepIndex = 0; stepIndex < maxSteps && time < settings.endTime - 1e-12; stepIndex += 1) {
    const nextTime = Math.min(time + settings.timeStep, settings.endTime);
    const dt = nextTime - time;
    const next = newmarkStep(system, u, v, a, loadScaleAt(nextTime, settings), dt, rayleighAlpha, rayleighBeta, options);
    if (!next.ok) return { ok: false, error: next.error };
    u.set(next.u);
    v.set(next.v);
    a = next.a;
    time = nextTime;
    if (time >= nextOutputTime - 1e-12 || time >= settings.endTime - 1e-12) {
      pushFrame(loadScaleAt(time, settings));
      while (nextOutputTime <= time + 1e-12) nextOutputTime += settings.outputInterval;
    }
  }

  const peakDisplacement = Math.max(...frames.map((frame) => maxAbs(frame.displacement.values)), 0);
  const peakVelocity = Math.max(...frames.map((frame) => maxAbs(frame.velocity.values)), 0);
  const peakAcceleration = Math.max(...frames.map((frame) => maxAbs(frame.acceleration.values)), 0);
  const equivalentMass = sum(lumpedMass);
  const equivalentStiffness = estimateEquivalentStiffness(system);

  const diagnostics: DynamicTet4CpuDiagnostics = {
    dofs: model.counts.nodes * 3,
    freeDofs: free.length,
    constrainedDofs: constraints.values.size,
    relativeResidual: 0,
    maxDisplacement: peakDisplacement,
    maxVonMisesStress: Math.max(...frames.map((frame) => maxAbs(frame.vonMises.values)), 0),
    solverMode: "sparse",
    converged: true,
    frameCount: frames.length,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timeStep: settings.timeStep,
    outputInterval: settings.outputInterval,
    dampingRatio: settings.dampingRatio,
    loadProfile: settings.loadProfile,
    equivalentMass,
    equivalentStiffness,
    peakDisplacement,
    peakVelocity,
    peakAcceleration,
    solver: "opencae-core-mdof-newmark"
  };

  return {
    ok: true,
    result: {
      staticResult: {
        displacement: frames.at(-1)?.displacement.values ?? new Float64Array(model.counts.nodes * 3),
        reactionForce: new Float64Array(model.counts.nodes * 3),
        strain: new Float64Array(model.counts.elements * 6),
        stress: frames.at(-1)?.stress.values ?? new Float64Array(model.counts.elements * 6),
        vonMises: frames.at(-1)?.vonMises.values ?? new Float64Array(model.counts.elements)
      },
      frames
    },
    diagnostics
  };
}

function dynamicSettings(model: NormalizedOpenCAEModel, options: DynamicTet4CpuOptions): DynamicSettings {
  const selectedStep = model.steps[options.stepIndex ?? 0];
  const dynamicStep = selectedStep?.type === "dynamicLinear" ? selectedStep : undefined;
  const timeStep = Math.max(finiteOr(options.timeStep, dynamicStep?.timeStep ?? DEFAULT_TIME_STEP_SECONDS), 1e-6);
  const profile = options.loadProfile ?? dynamicStep?.loadProfile ?? "ramp";
  return {
    startTime: finiteOr(options.startTime, dynamicStep?.startTime ?? 0),
    endTime: finiteOr(options.endTime, dynamicStep?.endTime ?? DEFAULT_END_TIME_SECONDS),
    timeStep,
    outputInterval: Math.max(finiteOr(options.outputInterval, dynamicStep?.outputInterval ?? DEFAULT_OUTPUT_INTERVAL_SECONDS), timeStep),
    dampingRatio: Math.max(finiteOr(options.dampingRatio, dynamicStep?.dampingRatio ?? DEFAULT_DAMPING_RATIO), 0),
    loadProfile: isDynamicLoadProfile(profile) ? profile : "ramp",
    massDensity: Math.max(finiteOr(options.massDensity, DEFAULT_MASS_DENSITY_KG_PER_M3), 1e-9)
  };
}

function newmarkStep(
  system: ReducedSystem,
  u: Float64Array,
  v: Float64Array,
  a: Float64Array,
  loadScale: number,
  dt: number,
  rayleighAlpha: number,
  rayleighBeta: number,
  options: DynamicTet4CpuOptions
): { ok: true; u: Float64Array; v: Float64Array; a: Float64Array } | { ok: false; error: CpuSolverError } {
  const beta = 0.25;
  const gamma = 0.5;
  const a0 = 1 / (beta * dt * dt);
  const a1 = gamma / (beta * dt);
  const a2 = 1 / (beta * dt);
  const a3 = 1 / (2 * beta) - 1;
  const a4 = gamma / beta - 1;
  const a5 = dt * (gamma / (2 * beta) - 1);
  const effective = effectiveMatrix(system.stiffness, system.mass, a0 + a1 * rayleighAlpha, 1 + a1 * rayleighBeta);
  const historyMass = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    historyMass[i] = system.mass[i] * (a0 * u[i] + a2 * v[i] + a3 * a[i]);
  }
  const dampingHistoryVector = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    dampingHistoryVector[i] = a1 * u[i] + a4 * v[i] + a5 * a[i];
  }
  const dampingHistory = dampingProduct(system, dampingHistoryVector, rayleighAlpha, rayleighBeta);
  const rhs = new Float64Array(u.length);
  for (let i = 0; i < rhs.length; i += 1) {
    rhs[i] = loadScale * system.load[i] + historyMass[i] + dampingHistory[i];
  }
  const solve = conjugateGradient(effective, rhs, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations,
    jacobi: true
  });
  if (!solve.ok) return { ok: false, error: solve.error };
  const nextU = solve.solution;
  const nextA = new Float64Array(u.length);
  const nextV = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    nextA[i] = a0 * (nextU[i] - u[i]) - a2 * v[i] - a3 * a[i];
    nextV[i] = v[i] + dt * ((1 - gamma) * a[i] + gamma * nextA[i]);
  }
  return { ok: true, u: nextU, v: nextV, a: nextA };
}

function initialAcceleration(
  system: ReducedSystem,
  settings: DynamicSettings,
  rayleighAlpha: number,
  rayleighBeta: number
): Float64Array {
  const acceleration = new Float64Array(system.free.length);
  const forceScale = loadScaleAt(settings.startTime, settings);
  const damping = dampingProduct(system, new Float64Array(system.free.length), rayleighAlpha, rayleighBeta);
  const stiffness = csrMatVec(system.stiffness, new Float64Array(system.free.length));
  for (let i = 0; i < acceleration.length; i += 1) {
    acceleration[i] = (forceScale * system.load[i] - damping[i] - stiffness[i]) / system.mass[i];
  }
  return acceleration;
}

function effectiveMatrix(stiffness: CsrMatrix, mass: Float64Array, massScale: number, stiffnessScale: number): CsrMatrix {
  const builder = createSparseMatrixBuilder(stiffness.rowCount, stiffness.colCount);
  for (let row = 0; row < stiffness.rowCount; row += 1) {
    for (let entry = stiffness.rowPtr[row]; entry < stiffness.rowPtr[row + 1]; entry += 1) {
      addSparseEntry(builder, row, stiffness.colInd[entry], stiffness.values[entry] * stiffnessScale);
    }
    addSparseEntry(builder, row, row, mass[row] * massScale);
  }
  return toCsrMatrix(builder);
}

function dampingProduct(system: ReducedSystem, vector: Float64Array, alpha: number, beta: number): Float64Array {
  const result = new Float64Array(vector.length);
  const kv = beta !== 0 ? csrMatVec(system.stiffness, vector) : new Float64Array(vector.length);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = alpha * system.mass[i] * vector[i] + beta * kv[i];
  }
  return result;
}

function createFrame(
  model: NormalizedOpenCAEModel,
  free: Int32Array,
  reducedU: Float64Array,
  reducedV: Float64Array,
  reducedA: Float64Array,
  frameIndex: number,
  timeSeconds: number,
  loadScale: number
): DynamicTet4CpuFrame {
  const displacement = expandFreeVector(model.counts.nodes * 3, free, reducedU);
  const velocity = expandFreeVector(model.counts.nodes * 3, free, reducedV);
  const acceleration = expandFreeVector(model.counts.nodes * 3, free, reducedA);
  const recovery = recoverElementResults(model, displacement);
  const stress = recovery.ok ? recovery.stress : new Float64Array(model.counts.elements * 6);
  const vonMises = recovery.ok ? recovery.vonMises : new Float64Array(model.counts.elements);
  const safetyFactor = computeSafetyFactor(model, vonMises);
  return {
    frameIndex,
    timeSeconds,
    loadScale,
    displacement: field(displacement, frameIndex, timeSeconds),
    velocity: field(velocity, frameIndex, timeSeconds),
    acceleration: field(acceleration, frameIndex, timeSeconds),
    stress: field(stress, frameIndex, timeSeconds),
    vonMises: field(vonMises, frameIndex, timeSeconds),
    safety_factor: field(safetyFactor, frameIndex, timeSeconds)
  };
}

function assembleLumpedMass(model: NormalizedOpenCAEModel, fallbackDensity: number): Float64Array {
  const nodalMass = new Float64Array(model.counts.nodes);
  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") continue;
    const material = model.materials[block.materialIndex];
    const density = material.density ?? fallbackDensity;
    for (let offset = 0; offset < block.connectivity.length; offset += 4) {
      const geometry = computeTet4Geometry(tetCoordinates(model.nodes.coordinates, block.connectivity, offset));
      if (!geometry.ok) continue;
      const nodeMass = (geometry.volume * density) / 4;
      for (let localNode = 0; localNode < 4; localNode += 1) {
        nodalMass[block.connectivity[offset + localNode]] += nodeMass;
      }
    }
  }
  const dofMass = new Float64Array(model.counts.nodes * 3);
  for (let node = 0; node < nodalMass.length; node += 1) {
    dofMass[node * 3] = nodalMass[node];
    dofMass[node * 3 + 1] = nodalMass[node];
    dofMass[node * 3 + 2] = nodalMass[node];
  }
  return dofMass;
}

function computeSafetyFactor(model: NormalizedOpenCAEModel, vonMises: Float64Array): Float64Array {
  const values = new Float64Array(vonMises.length);
  let element = 0;
  for (const block of model.elementBlocks) {
    const yieldStrength = model.materials[block.materialIndex]?.yieldStrength ?? 0;
    const count = Math.floor(block.connectivity.length / 4);
    for (let i = 0; i < count; i += 1) {
      values[element] = yieldStrength > 0 && vonMises[element] > 0 ? yieldStrength / vonMises[element] : 0;
      element += 1;
    }
  }
  return values;
}

function field(values: Float64Array, frameIndex: number, timeSeconds: number): DynamicResultField {
  return {
    values,
    samples: sampleIndices(values.length),
    frameIndex,
    timeSeconds
  };
}

function sampleIndices(length: number): number[] {
  if (length === 0) return [];
  const result = new Set<number>([0, length - 1]);
  if (length > 2) result.add(Math.floor(length / 2));
  return [...result].sort((a, b) => a - b);
}

function expandFreeVector(dofs: number, free: Int32Array, reduced: Float64Array): Float64Array {
  const full = new Float64Array(dofs);
  for (let i = 0; i < free.length; i += 1) full[free[i]] = reduced[i];
  return full;
}

function estimateEquivalentStiffness(system: ReducedSystem): number {
  const ku = csrMatVec(system.stiffness, system.load);
  const numerator = dot(system.load, ku);
  const denominator = Math.max(dot(system.load, system.load), 1e-30);
  return Math.max(numerator / denominator, 0);
}

function tetCoordinates(coordinates: Float64Array, connectivity: Uint32Array, offset: number): Float64Array {
  const result = new Float64Array(12);
  for (let localNode = 0; localNode < 4; localNode += 1) {
    const node = connectivity[offset + localNode] ?? 0;
    result[localNode * 3] = coordinates[node * 3] ?? 0;
    result[localNode * 3 + 1] = coordinates[node * 3 + 1] ?? 0;
    result[localNode * 3 + 2] = coordinates[node * 3 + 2] ?? 0;
  }
  return result;
}

function loadScaleAt(time: number, settings: DynamicSettings): number {
  const s = clamp((time - settings.startTime) / Math.max(settings.endTime - settings.startTime, settings.timeStep), 0, 1);
  if (settings.loadProfile === "ramp") return s;
  if (settings.loadProfile === "quasi_static" || settings.loadProfile === "quasiStatic") return 3 * s * s - 2 * s * s * s;
  if (settings.loadProfile === "sinusoidal") return Math.sin(Math.PI * s);
  return 1;
}

function isDynamicLoadProfile(value: unknown): value is DynamicLoadProfile {
  return value === "step" || value === "ramp" || value === "quasiStatic" || value === "quasi_static" || value === "sinusoidal";
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function sum(values: Float64Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function dot(a: Float64Array, b: Float64Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result += a[i] * b[i];
  return result;
}

function failure(code: string, message: string): DynamicTet4CpuSolveResult {
  return {
    ok: false,
    error: { code, message }
  };
}
