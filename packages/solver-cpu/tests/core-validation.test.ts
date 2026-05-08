import { describe, expect, test } from "vitest";
import { bracketActualMeshFixture, singleTetStaticFixture } from "@opencae/examples";
import {
  connectedComponents,
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  solverSurfaceMeshFromModel,
  surfaceArea,
  type OpenCAEModelJson,
  type SolverSurfaceMesh,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import {
  solveDynamicLinearTetMDOF,
  solveStaticLinearTet,
  solveStaticLinearTet4Cpu
} from "../src";

const HEX_TETS = [
  0, 1, 3, 4,
  1, 2, 3, 6,
  1, 3, 4, 6,
  1, 4, 5, 6,
  3, 4, 6, 7
];

describe("Core validation suite static benchmarks", () => {
  test("axial bar tension tracks F/A stress, FL/AE displacement, and reaction balance", () => {
    const length = 1;
    const area = 1;
    const youngModulus = 1000;
    const force = 100;
    const model = createHexBarModel({
      length,
      youngModulus,
      loads: [{ name: "axialLoad", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [force, 0, 0] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rightNodes = getNodeSet(model, "rightNodes");
    const meanTipDisplacement = mean(rightNodes.map((node) => result.result.displacement[node * 3]));
    const expectedDisplacement = (force * length) / (area * youngModulus);
    const expectedStress = force / area;
    const reaction = sumVectorDofs(result.result.reactionForce);

    expect(meanTipDisplacement).toBeCloseTo(expectedDisplacement, 0);
    expect(result.diagnostics.maxVonMisesStress).toBeGreaterThan(0.25 * expectedStress);
    expect(result.diagnostics.maxVonMisesStress).toBeLessThan(2.5 * expectedStress);
    expect(reaction[0]).toBeCloseTo(-force, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("cantilever benchmark stays within documented coarse Tet4 beam-theory tolerances", () => {
    const length = 4;
    const youngModulus = 1e6;
    const force = 10;
    const height = 1;
    const width = 1;
    const inertia = (width * height ** 3) / 12;
    const expectedTipDisplacement = (force * length ** 3) / (3 * youngModulus * inertia);
    const expectedStress = (force * length * (height / 2)) / inertia;
    const model = createHexBarModel({
      length,
      youngModulus,
      fixedLeftFace: true,
      loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [0, -force, 0] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rightNodes = getNodeSet(model, "rightNodes");
    const meanTipDisplacement = Math.abs(mean(rightNodes.map((node) => result.result.displacement[node * 3 + 1])));
    const reaction = sumVectorDofs(result.result.reactionForce);

    expect(meanTipDisplacement).toBeGreaterThan(0.05 * expectedTipDisplacement);
    expect(meanTipDisplacement).toBeLessThan(25 * expectedTipDisplacement);
    expect(result.diagnostics.maxVonMisesStress).toBeGreaterThan(0.05 * expectedStress);
    expect(result.diagnostics.maxVonMisesStress).toBeLessThan(25 * expectedStress);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(force, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("pressure patch total force equals pressure times area and balances reactions", () => {
    const pressure = 25;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      fixedLeftFace: true,
      loads: [{ name: "pressure", type: "pressure", surfaceSet: "rightFace", pressure, direction: [1, 0, 0] }],
      stepType: "staticLinear"
    });
    const rightSurface = getSurfaceSet(model, "rightFace");
    const force = pressure * surfaceArea(rightSurface, model.surfaceFacets ?? []);

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(force).toBeCloseTo(pressure);
    expect(reaction[0]).toBeCloseTo(-force, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("body gravity total force equals mass times acceleration", () => {
    const density = 7;
    const acceleration = -9.81;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      density,
      fixedLeftFace: true,
      loads: [{ name: "gravity", type: "bodyGravity", acceleration: [0, 0, acceleration] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(-(density * acceleration), 8);
  });
});

describe("Core validation suite sparse solver", () => {
  test("dense and sparse match on a constrained small mesh", () => {
    const dense = solveStaticLinearTet(singleTetStaticFixture, { method: "dense" });
    const sparse = solveStaticLinearTet(singleTetStaticFixture, { method: "sparse", tolerance: 1e-12 });

    expect(dense.ok).toBe(true);
    expect(sparse.ok).toBe(true);
    if (!dense.ok || !sparse.ok) return;
    expect(sparse.diagnostics.converged).toBe(true);
    expect(sparse.diagnostics.iterations).toBeGreaterThan(0);
    for (let index = 0; index < dense.result.displacement.length; index += 1) {
      expect(sparse.result.displacement[index]).toBeCloseTo(dense.result.displacement[index], 8);
    }
  });

  test("singular unconstrained model fails clearly while constrained model solves", () => {
    const singular: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [],
      steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: [], loads: ["tipLoad"] }]
    };

    const failed = solveStaticLinearTet4Cpu(singular, { method: "sparse" });
    const solved = solveStaticLinearTet4Cpu(singleTetStaticFixture, { method: "sparse" });

    expect(failed.ok).toBe(false);
    expect(failed.ok ? undefined : failed.error.code).toBe("singular-system");
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });
});

describe("Core validation suite dynamic benchmarks", () => {
  test("zero load remains zero", () => {
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      loads: [],
      stepType: "dynamicLinear"
    });

    const result = solveDynamicLinearTetMDOF(model);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const frame of result.result.frames) {
      expect(maxAbs(frame.displacement.values)).toBe(0);
      expect(maxAbs(frame.velocity.values)).toBe(0);
      expect(maxAbs(frame.acceleration.values)).toBe(0);
    }
  });

  test("ramp starts near zero, step peaks early, and half-sine starts and ends at zero load", () => {
    const ramp = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"));
    const step = solveDynamicLinearTetMDOF(dynamicLoadedModel("step"));
    const sine = solveDynamicLinearTetMDOF(dynamicLoadedModel("sinusoidal"));

    expect(ramp.ok && step.ok && sine.ok).toBe(true);
    if (!ramp.ok || !step.ok || !sine.ok) return;
    expect(maxAbs(ramp.result.frames[0].displacement.values)).toBeLessThan(1e-14);
    expect(step.result.frames[0].loadScale).toBe(1);
    expect(maxAbs(step.result.frames[0].acceleration.values)).toBeGreaterThan(0);
    expect(sine.result.frames[0].loadScale).toBeCloseTo(0);
    expect(sine.result.frames.at(-1)?.loadScale ?? -1).toBeCloseTo(0);
  });

  test("outputInterval controls frame count and response changes across frames", () => {
    const result = solveDynamicLinearTetMDOF(dynamicLoadedModel("step"), {
      endTime: 0.03,
      timeStep: 0.005,
      outputInterval: 0.015,
      dampingRatio: 0
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames.map((frame) => frame.timeSeconds)).toEqual([0, 0.015, 0.03]);
    const signatures = new Set(
      result.result.frames.map((frame) =>
        Array.from(frame.displacement.values).map((value) => value.toExponential(6)).join(",")
      )
    );
    expect(signatures.size).toBeGreaterThan(1);
  });

  test("dynamic validation fails for missing density and excessive frame budget", () => {
    const missingDensity = solveDynamicLinearTetMDOF(singleTetStaticFixture);
    const tooManyFrames = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"), {
      endTime: 1,
      timeStep: 0.001,
      outputInterval: 0.001,
      maxFrames: 10
    });

    expect(missingDensity.ok).toBe(false);
    expect(missingDensity.ok ? undefined : missingDensity.error.message).toContain("Dynamic solve requires material density.");
    expect(tooManyFrames.ok).toBe(false);
    expect(tooManyFrames.ok ? undefined : tooManyFrames.error.code).toBe("too-many-frames");
    expect(tooManyFrames.ok ? undefined : tooManyFrames.error.message).toContain("exceeding maxFrames");
  });
});

describe("Core validation suite complex geometry regression", () => {
  test("bracket-like Tet mesh stays connected through static and dynamic result topology", () => {
    const components = connectedComponents(bracketActualMeshFixture);
    const support = bracketActualMeshFixture.surfaceSets?.find((set) => set.name === "base_mount");
    const load = bracketActualMeshFixture.surfaceSets?.find((set) => set.name === "upright_load");

    expect(components.componentCount).toBe(1);
    expect(support?.facets.length).toBeGreaterThan(0);
    expect(load?.facets.length).toBeGreaterThan(0);
    expect(nodeSetFromSurfaceSet(support!, bracketActualMeshFixture.surfaceFacets ?? []).length).toBeGreaterThan(0);
    expect(nodeSetFromSurfaceSet(load!, bracketActualMeshFixture.surfaceFacets ?? []).length).toBeGreaterThan(0);

    const staticResult = solveStaticLinearTet(bracketActualMeshFixture, { method: "sparse", tolerance: 1e-10 });
    const dynamicResult = solveDynamicLinearTetMDOF(bracketActualMeshFixture, {
      stepIndex: 1,
      maxFrames: 50,
      tolerance: 1e-10
    });

    expect(staticResult.ok).toBe(true);
    expect(dynamicResult.ok).toBe(true);
    if (!staticResult.ok || !dynamicResult.ok) return;
    const staticSurface = staticResult.result.coreResult?.surfaceMesh ?? solverSurfaceMeshFromModel(bracketActualMeshFixture);
    const dynamicSurface = dynamicResult.result.coreResult?.surfaceMesh ?? solverSurfaceMeshFromModel(bracketActualMeshFixture);
    expect(surfaceMeshComponentCount(staticSurface)).toBe(1);
    expect(surfaceMeshComponentCount(dynamicSurface)).toBe(1);
    expect(staticResult.diagnostics.relativeResidual).toBeLessThan(1e-7);
    expect(dynamicResult.result.frames.length).toBeGreaterThan(1);
  });
});

function createHexBarModel(options: {
  length: number;
  youngModulus: number;
  density?: number;
  fixedLeftFace?: boolean;
  loads: OpenCAEModelJson["loads"];
  stepType: "staticLinear" | "dynamicLinear";
}): OpenCAEModelJson {
  const coordinates = [
    0, 0, 0,
    options.length, 0, 0,
    options.length, 1, 0,
    0, 1, 0,
    0, 0, 1,
    options.length, 0, 1,
    options.length, 1, 1,
    0, 1, 1
  ];
  const base: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [
      {
        name: "benchmark",
        type: "isotropicLinearElastic",
        youngModulus: options.youngModulus,
        poissonRatio: 0,
        density: options.density ?? 1,
        yieldStrength: 1e9
      }
    ],
    elementBlocks: [{ name: "hex-tet", type: "Tet4", material: "benchmark", connectivity: HEX_TETS }],
    nodeSets: [],
    elementSets: [{ name: "all", elements: [0, 1, 2, 3, 4] }],
    boundaryConditions: [],
    loads: options.loads,
    steps: []
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const leftFace = surfaceSetByX("leftFace", surfaceFacets, coordinates, 0);
  const rightFace = surfaceSetByX("rightFace", surfaceFacets, coordinates, options.length);
  const leftNodes = nodeSetFromSurfaceSet(leftFace, surfaceFacets);
  const rightNodes = nodeSetFromSurfaceSet(rightFace, surfaceFacets);
  const supportConditions: OpenCAEModelJson["boundaryConditions"] = options.fixedLeftFace
    ? [{ name: "fixedLeft", type: "fixed", nodeSet: "leftNodes", components: ["x", "y", "z"] }]
    : [
        { name: "leftX", type: "fixed", nodeSet: "leftNodes", components: ["x"] },
        { name: "pinYZ", type: "fixed", nodeSet: "pinNode", components: ["y", "z"] },
        { name: "rollerZ", type: "fixed", nodeSet: "rollerNode", components: ["z"] }
      ];

  return {
    ...base,
    surfaceFacets,
    surfaceSets: [leftFace, rightFace],
    nodeSets: [
      { name: "leftNodes", nodes: leftNodes },
      { name: "rightNodes", nodes: rightNodes },
      { name: "pinNode", nodes: [0] },
      { name: "rollerNode", nodes: [3] }
    ],
    boundaryConditions: supportConditions,
    steps: [
      options.stepType === "staticLinear"
        ? { name: "loadStep", type: "staticLinear", boundaryConditions: supportConditions.map((bc) => bc.name), loads: options.loads.map((load) => load.name) }
        : {
            name: "loadStep",
            type: "dynamicLinear",
            boundaryConditions: supportConditions.map((bc) => bc.name),
            loads: options.loads.map((load) => load.name),
            startTime: 0,
            endTime: 0.04,
            timeStep: 0.005,
            outputInterval: 0.01,
            loadProfile: "ramp",
            dampingRatio: 0.02
          }
    ]
  };
}

function dynamicLoadedModel(loadProfile: "ramp" | "step" | "sinusoidal"): OpenCAEModelJson {
  const model = createHexBarModel({
    length: 1,
    youngModulus: 1000,
    loads: [{ name: "axialLoad", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [100, 0, 0] }],
    stepType: "dynamicLinear"
  });
  return {
    ...model,
    steps: model.steps.map((step) => (step.type === "dynamicLinear" ? { ...step, loadProfile } : step))
  };
}

function surfaceSetByX(name: string, facets: SurfaceFacetJson[], coordinates: number[], x: number): SurfaceSetJson {
  return {
    name,
    facets: facets
      .filter((facet) => facet.nodes.every((node) => Math.abs(coordinates[node * 3] - x) < 1e-12))
      .map((facet) => facet.id)
  };
}

function getNodeSet(model: OpenCAEModelJson, name: string): number[] {
  return model.nodeSets.find((nodeSet) => nodeSet.name === name)?.nodes ?? [];
}

function getSurfaceSet(model: OpenCAEModelJson, name: string): SurfaceSetJson {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === name);
  if (!surfaceSet) throw new Error(`Missing surface set ${name}`);
  return surfaceSet;
}

function sumVectorDofs(values: Float64Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < values.length; index += 3) {
    sum[0] += values[index];
    sum[1] += values[index + 1];
    sum[2] += values[index + 2];
  }
  return sum;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function surfaceMeshComponentCount(surfaceMesh: SolverSurfaceMesh): number {
  const nodeAdjacency = new Map<number, Set<number>>();
  for (let node = 0; node < surfaceMesh.nodes.length; node += 1) {
    nodeAdjacency.set(node, new Set());
  }
  for (const triangle of surfaceMesh.triangles) {
    for (let index = 0; index < triangle.length; index += 1) {
      const a = triangle[index];
      const b = triangle[(index + 1) % triangle.length];
      nodeAdjacency.get(a)?.add(b);
      nodeAdjacency.get(b)?.add(a);
    }
  }

  let components = 0;
  const seen = new Set<number>();
  for (const node of nodeAdjacency.keys()) {
    if (seen.has(node)) continue;
    components += 1;
    const stack = [node];
    seen.add(node);
    while (stack.length > 0) {
      const current = stack.pop() ?? 0;
      for (const next of nodeAdjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  return components;
}
