import { describe, expect, test } from "vitest";
import { bracketActualMeshFixture, singleTetStaticFixture } from "@opencae/examples";
import {
  connectedComponents,
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  normalizeModelJson,
  solverSurfaceMeshFromModel,
  surfaceArea,
  type OpenCAEModelJson,
  type SolverSurfaceMesh,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import {
  solveDynamicLinearTetMDOF,
  recoverNodalVonMisesFromElements,
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

  test("aluminum cantilever sanity result matches app-facing MPa mm N bands", () => {
    const force = 500;
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    expect(coreResult?.summary.provenance).toBeDefined();
    expect(coreResult?.summary.maxStressUnits).toBe("Pa");
    expect(coreResult?.summary.maxDisplacementUnits).toBe("m");
    expect(coreResult?.summary.reactionForceUnits).toBe("N");

    const maxStressMpa = (coreResult?.summary.maxStress ?? 0) / 1_000_000;
    const maxDisplacementMm = (coreResult?.summary.maxDisplacement ?? 0) * 1000;
    const reactionForce = coreResult?.summary.reactionForce ?? 0;

    expect(maxStressMpa).toBeGreaterThanOrEqual(25);
    expect(maxStressMpa).toBeLessThanOrEqual(45);
    expect(maxDisplacementMm).toBeGreaterThanOrEqual(0.35);
    expect(maxDisplacementMm).toBeLessThanOrEqual(0.75);
    expect(reactionForce).toBeGreaterThanOrEqual(495);
    expect(reactionForce).toBeLessThanOrEqual(505);
    expect(Number.isFinite(coreResult?.summary.safetyFactor)).toBe(true);
  });

  test("cantilever stress contour uses aligned recovered surface nodal values", () => {
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force: 500,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    const surfaceMesh = coreResult?.surfaceMesh;
    const stressField = coreResult?.fields.find((field) => field.id === "stress-surface");
    const displacementField = coreResult?.fields.find((field) => field.id === "displacement-surface");
    const engineeringStressField = coreResult?.fields.find((field) => field.id === "stress-von-mises-element");
    const safetyFactorField = coreResult?.fields.find((field) => field.id === "safety-factor");

    expect(surfaceMesh).toBeDefined();
    expect(stressField?.location).toBe("node");
    expect(stressField?.units).toBe("MPa");
    expect(stressField?.surfaceMeshRef).toBe(surfaceMesh?.id);
    expect(stressField?.visualizationSource).toBe("volume_weighted_nodal_recovery");
    expect(stressField?.engineeringSource).toBe("raw_element_von_mises");
    expect(stressField?.values).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    expect(displacementField?.units).toBe("mm");
    expect(displacementField?.values).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    expect(displacementField?.vectors).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    const normalized = normalizeModelJson(model);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || !surfaceMesh || !stressField || !displacementField) return;
    const recoveredNodalVonMises = recoverNodalVonMisesFromElements(normalized.model, result.result.vonMises);
    const expectedSurfaceStress = surfaceMesh.nodeMap.map((volumeNode) => recoveredNodalVonMises[volumeNode] / 1_000_000);
    const expectedSurfaceDisplacement = surfaceMesh.nodeMap.map((volumeNode) => {
      const offset = volumeNode * 3;
      return Math.hypot(
        result.result.displacement[offset],
        result.result.displacement[offset + 1],
        result.result.displacement[offset + 2]
      ) * 1000;
    });
    const expectedSurfaceDisplacementVectors = surfaceMesh.nodeMap.map((volumeNode) => {
      const offset = volumeNode * 3;
      return [
        result.result.displacement[offset] * 1000,
        result.result.displacement[offset + 1] * 1000,
        result.result.displacement[offset + 2] * 1000
      ];
    });
    for (let index = 0; index < surfaceMesh.nodes.length; index += 1) {
      expect(stressField.values[index]).toBeCloseTo(expectedSurfaceStress[index] ?? 0, 12);
      expect(displacementField.values[index]).toBeCloseTo(expectedSurfaceDisplacement[index] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[0]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[0] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[1]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[1] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[2]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[2] ?? 0, 12);
    }
    expect(engineeringStressField?.location).toBe("element");
    expect(engineeringStressField?.surfaceMeshRef).toBeUndefined();
    expect(coreResult?.summary.maxStress).toBe(engineeringStressField?.max);
    expect(coreResult?.summary.safetyFactor).toBe(safetyFactorField?.min);
    expect(new Set(stressField?.values.map((value) => value.toPrecision(8))).size).toBeGreaterThan(24);

    const fixedStress = averageStressNearX(surfaceMesh!, stressField!.values, 0, 0.025);
    const freeStress = averageStressNearX(surfaceMesh!, stressField!.values, 0.18, 0.025);
    expect(fixedStress).toBeGreaterThan(freeStress * 1.6);

    const highStressNodes = highStressSurfaceNodes(surfaceMesh!, stressField!.values, 0.85);
    expect(highStressNodes.length).toBeGreaterThan(8);
    expect(uniqueRounded(highStressNodes.map((entry) => entry.node[1]), 5).size).toBeGreaterThan(1);
    expect(uniqueRounded(highStressNodes.map((entry) => entry.node[2]), 5).size).toBeGreaterThan(1);
  });

  test("static Core result includes stress visualization diagnostics", () => {
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force: 500,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    const stressField = coreResult?.fields.find((field) => field.id === "stress-surface");
    const displacementField = coreResult?.fields.find((field) => field.id === "displacement-surface");
    const diagnostic = coreResult?.diagnostics.find(isStressVisualizationDiagnostic);

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.engineeringStressMaxMpa).toBeCloseTo((coreResult?.summary.maxStress ?? 0) / 1_000_000, 12);
    expect(diagnostic?.plotStressMinMpa).toBe(stressField?.min);
    expect(diagnostic?.plotStressMaxMpa).toBe(stressField?.max);
    expect(diagnostic?.stressRecoveryMethod).toBe("volume_weighted_nodal_recovery");
    expect(diagnostic?.surfaceNodeCount).toBe(coreResult?.surfaceMesh?.nodes.length);
    expect(diagnostic?.surfaceTriangleCount).toBe(coreResult?.surfaceMesh?.triangles.length);
    expect(diagnostic?.stressFieldValueCount).toBe(stressField?.values.length);
    expect(diagnostic?.displacementFieldValueCount).toBe(displacementField?.values.length);
    expect(diagnostic?.stressFieldLocation).toBe("node");
    expect(diagnostic?.surfaceMeshRef).toBe(coreResult?.surfaceMesh?.id);
    expect(diagnostic?.visualizationSource).toBe("volume_weighted_nodal_recovery");
    expect(diagnostic?.fieldSurfaceAlignment).toBe("ok");
    expect(diagnostic?.fixedNodeCount).toBeGreaterThan(0);
    expect(diagnostic?.loadNodeCount).toBeGreaterThan(0);
    expect(diagnostic?.appliedLoadVector[0]).toBeCloseTo(0, 12);
    expect(diagnostic?.appliedLoadVector[1]).toBeCloseTo(0, 12);
    expect(diagnostic?.appliedLoadVector[2]).toBeCloseTo(-500, 6);
    expect(diagnostic?.reactionVector[2]).toBeCloseTo(500, 6);
    expect(diagnostic?.fixedCentroid[0]).toBeCloseTo(0, 12);
    expect(diagnostic?.loadCentroid[0]).toBeCloseTo(0.18, 12);
    expect(diagnostic?.effectiveLeverArmMm).toBeCloseTo(180, 8);
    expect(diagnostic?.stressByBeamAxisBin).toHaveLength(20);
    const populatedBins = diagnostic?.stressByBeamAxisBin.filter((bin) => bin.nodeCount > 0) ?? [];
    expect(populatedBins.length).toBeGreaterThan(4);
    expect(populatedBins[0]?.maxStress).toBeGreaterThan((populatedBins.at(-1)?.maxStress ?? 0) * 1.4);
    expect(diagnostic?.warnings).not.toContain("Stress field has an abrupt spatial discontinuity; verify surface node mapping and load/support selection.");
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

function createStructuredCantileverModel(options: {
  length: number;
  width: number;
  height: number;
  force: number;
  xDivisions: number;
  yDivisions: number;
  zDivisions: number;
}): OpenCAEModelJson {
  const coordinates: number[] = [];
  const nodeIndex = (i: number, j: number, k: number) =>
    i * (options.yDivisions + 1) * (options.zDivisions + 1) + j * (options.zDivisions + 1) + k;
  for (let i = 0; i <= options.xDivisions; i += 1) {
    const x = (options.length * i) / options.xDivisions;
    for (let j = 0; j <= options.yDivisions; j += 1) {
      const y = -options.width / 2 + (options.width * j) / options.yDivisions;
      for (let k = 0; k <= options.zDivisions; k += 1) {
        const z = -options.height / 2 + (options.height * k) / options.zDivisions;
        coordinates.push(x, y, z);
      }
    }
  }

  const connectivity: number[] = [];
  for (let i = 0; i < options.xDivisions; i += 1) {
    for (let j = 0; j < options.yDivisions; j += 1) {
      for (let k = 0; k < options.zDivisions; k += 1) {
        const cube = [
          nodeIndex(i, j, k),
          nodeIndex(i + 1, j, k),
          nodeIndex(i + 1, j + 1, k),
          nodeIndex(i, j + 1, k),
          nodeIndex(i, j, k + 1),
          nodeIndex(i + 1, j, k + 1),
          nodeIndex(i + 1, j + 1, k + 1),
          nodeIndex(i, j + 1, k + 1)
        ];
        for (let offset = 0; offset < HEX_TETS.length; offset += 4) {
          connectivity.push(
            cube[HEX_TETS[offset]!]!,
            cube[HEX_TETS[offset + 1]!]!,
            cube[HEX_TETS[offset + 2]!]!,
            cube[HEX_TETS[offset + 3]!]!
          );
        }
      }
    }
  }

  const base: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [
      {
        name: "Aluminum 6061",
        type: "isotropicLinearElastic",
        youngModulus: 68_900_000_000,
        poissonRatio: 0.33,
        density: 2700,
        yieldStrength: 276_000_000
      }
    ],
    elementBlocks: [{ name: "cantilever", type: "Tet4", material: "Aluminum 6061", connectivity }],
    nodeSets: [],
    elementSets: [{ name: "all", elements: Array.from({ length: connectivity.length / 4 }, (_value, index) => index) }],
    boundaryConditions: [],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const fixedFace = surfaceSetByX("fixedFace", surfaceFacets, coordinates, 0);
  const tipFace = surfaceSetByX("tipFace", surfaceFacets, coordinates, options.length);
  return {
    ...base,
    surfaceFacets,
    surfaceSets: [fixedFace, tipFace],
    nodeSets: [
      { name: "fixedNodes", nodes: nodeSetFromSurfaceSet(fixedFace, surfaceFacets) },
      { name: "tipNodes", nodes: nodeSetFromSurfaceSet(tipFace, surfaceFacets) }
    ],
    boundaryConditions: [{ name: "fixedSupport", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] }],
    loads: [{ name: "tipLoad", type: "surfaceForce", surfaceSet: "tipFace", totalForce: [0, 0, -options.force] }],
    steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedSupport"], loads: ["tipLoad"] }]
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

function averageStressNearX(
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  x: number,
  tolerance: number
): number {
  const samples = surfaceMesh.nodes
    .map((node, index) => ({ node, value: values[index] ?? 0 }))
    .filter((entry) => Math.abs(entry.node[0] - x) <= tolerance);
  return mean(samples.map((entry) => entry.value));
}

function highStressSurfaceNodes(
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  thresholdFraction: number
): { node: [number, number, number]; value: number }[] {
  const max = Math.max(...values);
  const threshold = max * thresholdFraction;
  return surfaceMesh.nodes
    .map((node, index) => ({ node, value: values[index] ?? 0 }))
    .filter((entry) => entry.value >= threshold);
}

function uniqueRounded(values: number[], decimals: number): Set<number> {
  const scale = 10 ** decimals;
  return new Set(values.map((value) => Math.round(value * scale) / scale));
}

function isStressVisualizationDiagnostic(value: unknown): value is {
  engineeringStressMaxMpa: number;
  plotStressMinMpa: number;
  plotStressMaxMpa: number;
  stressFieldLocation: string;
  surfaceMeshRef: string;
  visualizationSource: string;
  stressRecoveryMethod: string;
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  stressFieldValueCount: number;
  displacementFieldValueCount: number;
  fieldSurfaceAlignment: string;
  fixedNodeCount: number;
  loadNodeCount: number;
  appliedLoadVector: [number, number, number];
  reactionVector: [number, number, number];
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
  stressByBeamAxisBin: Array<{ bin: number; xCenter: number; meanStress: number; maxStress: number; nodeCount: number }>;
  warnings: string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "stressRecoveryMethod" in value &&
    (value as { stressRecoveryMethod?: unknown }).stressRecoveryMethod === "volume_weighted_nodal_recovery"
  );
}
