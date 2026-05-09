import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import type { OpenCAEModelJson } from "@opencae/core";
import { healthResponse, solveResponse } from "../src/server";

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
      provenance: { kind: string; resultSource: string; solver: string };
    };
    expect(body.ok).toBeUndefined();
    expect(body.result).toBeUndefined();
    expect(body.fields.length).toBeGreaterThan(0);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      resultSource: "computed",
      solver: "opencae-core-sparse-tet"
    });
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
      solver: "opencae-core-mdof-tet"
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
