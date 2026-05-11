import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import { solverSurfaceMeshFromModel, validateCoreResult, type CoreSolveResult, type OpenCAEModelJson } from "@opencae/core";
import { coreResultValidationFailureMessage, healthResponse, solveResponse } from "../src/server";

const densityModel = {
  ...singleTetStaticFixture,
  schemaVersion: "0.2.0",
  materials: [
    {
      ...singleTetStaticFixture.materials[0],
      density: 1200,
      yieldStrength: 250e6
    }
  ],
  steps: [
    {
      name: "dynamicStep",
      type: "dynamicLinear",
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      loads: ["tipLoad"],
      startTime: 0,
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "ramp"
    }
  ]
} satisfies OpenCAEModelJson;

describe("OpenCAE Core Cloud runner", () => {
  test("health reports Core-only production capabilities", () => {
    const response = healthResponse();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion: "0.1.2",
      coreVersion: "0.1.2",
      solverCpuVersion: "0.1.2",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      noCalculix: true,
      noLocalEstimateFallback: true
    });
  });

  test("solves static Core models with production provenance", () => {
    const response = solveResponse({
      runId: "static-1",
      analysisType: "static_stress",
      coreModel: singleTetStaticFixture
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      ok?: unknown;
      result?: unknown;
      fields: unknown[];
      provenance: { kind: string; resultSource: string; solver: string; runnerVersion?: string };
    };
    expect(body.ok).toBeUndefined();
    expect(body.result).toBeUndefined();
    expect(body.fields.length).toBeGreaterThan(0);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      resultSource: "computed",
      solver: "opencae-core-cloud"
    });
    expect(body.provenance.runnerVersion).toBeDefined();
  });

  test("does not synthesize or independently compact surface stress fields", () => {
    const response = solveResponse({
      runId: "static-compact",
      analysisType: "static_stress",
      coreModel: singleTetStaticFixture,
      resultSettings: { compact: true, maxFieldValues: 1 }
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      fields: Array<{
        id: string;
        type: string;
        location: string;
        values: number[];
        samples?: unknown[];
        surfaceMeshRef?: string;
      }>;
      surfaceMesh: { id: string; nodes: unknown[] };
    };
    const surfaceStress = body.fields.find((field) => field.id === "stress-surface");
    const elementStress = body.fields.find((field) => field.id === "stress-von-mises-element");

    expect(surfaceStress?.location).toBe("node");
    expect(surfaceStress?.surfaceMeshRef).toBe(body.surfaceMesh.id);
    expect(surfaceStress?.values).toHaveLength(body.surfaceMesh.nodes.length);
    expect(surfaceStress?.samples).toBeUndefined();
    expect(elementStress?.location).toBe("element");
    expect(elementStress?.surfaceMeshRef).toBeUndefined();
    expect(elementStress?.samples).toBeUndefined();
  });

  test("uses exact surface field mismatch message for result validation failures", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(singleTetStaticFixture);
    const report = validateCoreResult({
      summary: {
        maxStress: 10,
        maxStressUnits: "MPa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "mm",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "mm-N-s-MPa"
        }
      },
      fields: [
        {
          id: "stress-surface",
          type: "stress",
          location: "node",
          values: [1],
          min: 1,
          max: 1,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id
        }
      ],
      surfaceMesh,
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    } satisfies CoreSolveResult);

    expect(report.ok).toBe(false);
    expect(coreResultValidationFailureMessage(report)).toBe("Solver surface field length does not match surface mesh node count.");
  });

  test("solves dynamic Core models with MDOF production provenance", () => {
    const response = solveResponse({
      runId: "dynamic-1",
      analysisType: "dynamic_structural",
      coreModel: densityModel
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      ok?: unknown;
      result?: unknown;
      fields: Array<{ frameIndex?: number; timeSeconds?: number }>;
      provenance: { kind: string; resultSource: string; solver: string };
    };
    expect(body.ok).toBeUndefined();
    expect(body.result).toBeUndefined();
    expect(body.fields.some((field) => Number.isInteger(field.frameIndex) && Number.isFinite(field.timeSeconds))).toBe(true);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      resultSource: "computed",
      solver: "opencae-core-cloud"
    });
  });

  test("rejects invalid models with 422", () => {
    const invalid = {
      ...singleTetStaticFixture,
      elementBlocks: [{ ...singleTetStaticFixture.elementBlocks[0], connectivity: [0, 1, 2] }]
    };

    const response = solveResponse({
      analysisType: "static_stress",
      coreModel: invalid
    });

    expect(response.status).toBe(422);
  });

  test("accepts coreVolumeMesh and rejects ambiguous model inputs", () => {
    const response = solveResponse({
      analysisType: "static_stress",
      coreVolumeMesh: {
        nodes: singleTetStaticFixture.nodes,
        materials: singleTetStaticFixture.materials,
        elementBlocks: singleTetStaticFixture.elementBlocks,
        nodeSets: singleTetStaticFixture.nodeSets,
        boundaryConditions: singleTetStaticFixture.boundaryConditions,
        loads: singleTetStaticFixture.loads,
        steps: singleTetStaticFixture.steps
      }
    });
    const ambiguous = solveResponse({
      analysisType: "static_stress",
      coreModel: singleTetStaticFixture,
      coreVolumeMesh: {
        nodes: singleTetStaticFixture.nodes,
        materials: singleTetStaticFixture.materials,
        elementBlocks: singleTetStaticFixture.elementBlocks
      }
    });

    expect(response.status).toBe(200);
    expect(ambiguous.status).toBe(400);
  });

  test("rejects display proxy provenance at the cloud boundary", () => {
    const response = solveResponse({
      analysisType: "static_stress",
      coreModel: {
        ...singleTetStaticFixture,
        schemaVersion: "0.2.0",
        meshProvenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "display_bounds_proxy"
        }
      }
    });

    expect(response.status).toBe(400);
  });

  test("rejects preview requests", () => {
    const response = solveResponse({
      analysisType: "dynamic_structural",
      coreModel: densityModel,
      solverSettings: { allowPreview: true }
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "preview-disabled" }
    });
  });
});
