import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import { solverSurfaceMeshFromModel, validateCoreResult, type CoreSolveResult, type OpenCAEModelJson } from "@opencae/core";
import { assertGmshAvailable } from "../src/mesh/gmsh";
import { coreResultValidationFailureMessage, healthResponse, solveResponse } from "../src/server";
import type { CoreCloudGeometryPayload, CoreCloudSolveRequest } from "../src/types";

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
  test("health reports Core-only production meshing capabilities", async () => {
    const response = await healthResponse();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion: "0.1.3",
      coreVersion: "0.1.2",
      solverCpuVersion: "0.1.2",
      mesher: "gmsh",
      supportsProceduralGeometry: true,
      supportsUploadedCad: true,
      supportsGeometryToMesh: true,
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      noCalculix: true,
      noLocalEstimateFallback: true
    });
    expect((response.body as { gmshAvailable?: unknown }).gmshAvailable).toEqual(expect.any(Boolean));
  });

  test("solves static Core models with production provenance", async () => {
    const response = await solveResponse({
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

  test("does not synthesize or independently compact surface stress fields", async () => {
    const response = await solveResponse({
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

  test("solves dynamic Core models with MDOF production provenance", async () => {
    const response = await solveResponse({
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

  test("rejects invalid models with 422", async () => {
    const invalid = {
      ...singleTetStaticFixture,
      elementBlocks: [{ ...singleTetStaticFixture.elementBlocks[0], connectivity: [0, 1, 2] }]
    };

    const response = await solveResponse({
      analysisType: "static_stress",
      coreModel: invalid
    });

    expect(response.status).toBe(422);
  });

  test("accepts coreVolumeMesh and rejects ambiguous model inputs", async () => {
    const response = await solveResponse({
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
    const ambiguous = await solveResponse({
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

  test("exports Core Cloud request aliases and rejects ambiguous geometry inputs", async () => {
    const geometry = {
      kind: "structured_block",
      units: "mm",
      descriptor: { length: 20, width: 10, height: 8 }
    } satisfies CoreCloudGeometryPayload;
    const request = {
      analysisType: "static_stress",
      geometry
    } satisfies CoreCloudSolveRequest;

    const response = await solveResponse({
      ...request,
      coreModel: singleTetStaticFixture
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "invalid-request" }
    });
  });

  test("rejects display proxy provenance at the cloud boundary", async () => {
    const response = await solveResponse({
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

  test("rejects preview requests", async () => {
    const response = await solveResponse({
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

  test("requires procedural or uploaded geometry for complex Core Cloud meshing requests", async () => {
    const response = await solveResponse({
      runId: "missing-geometry",
      analysisType: "static_stress",
      study: { id: "study-bracket", type: "static_stress" },
      displayModel: { id: "display-bracket", name: "Bracket Demo", features: ["holes", "gusset"] },
      solverSettings: {}
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: "geometry-required",
        message: "Complex geometry requires procedural or uploaded geometry for Core Cloud meshing."
      }
    });
  });

  test("reports unavailable Gmsh as a meshing error without fallback", async () => {
    const response = await solveResponse({
      runId: "bad-upload",
      analysisType: "static_stress",
      study: { id: "study-upload", type: "static_stress" },
      geometry: { kind: "uploaded_cad", format: "step", filename: "missing.step" },
      solverSettings: {}
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "meshing-failed" }
    });
    expect(JSON.stringify(response.body)).toContain("No local estimate fallback was used.");
  });

  test("returns mesh summary, generated model, and phase diagnostics for generated geometry solves", async () => {
    const response = await solveResponse({
      runId: "structured-block-static",
      analysisType: "static_stress",
      study: bracketStudy(),
      geometry: {
        kind: "structured_block",
        units: "mm",
        descriptor: { length: 20, width: 10, height: 8 }
      },
      solverSettings: { maxIterations: 10000, tolerance: 1e-8 }
    });

    expect(response.status).toBe(200);
    const body = response.body as CoreSolveResult & {
      artifacts?: {
        generatedCoreModel?: unknown;
        meshSummary?: {
          nodeCount: number;
          elementCount: number;
          phaseDiagnostics: Array<{ phase: string }>;
        };
      };
      diagnostics: Array<{ phase?: string; id?: string }>;
    };
    expect(body.artifacts?.generatedCoreModel).toBeDefined();
    expect(body.artifacts?.meshSummary).toMatchObject({
      nodeCount: 8,
      elementCount: 6
    });
    expect(body.artifacts?.meshSummary?.phaseDiagnostics.map((diagnostic) => diagnostic.phase)).toEqual(
      expect.arrayContaining(["geometry_received", "mesh_parsed", "core_model_built", "core_model_validated", "core_solve_started", "core_solve_complete", "result_postprocessed"])
    );
    expect(body.diagnostics.map((diagnostic) => diagnostic.phase).filter(Boolean)).toEqual(
      expect.arrayContaining(["geometry_received", "core_model_validated", "core_solve_complete", "result_postprocessed"])
    );
  });

  test("solves procedural bracket geometry with actual Core mesh when Gmsh is available", async () => {
    const availability = await assertGmshAvailable();
    if (!availability.available) return;

    const response = await solveResponse({
      runId: "bracket-static",
      analysisType: "static_stress",
      study: bracketStudy(),
      geometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm",
        descriptor: { meshSize: 24 }
      },
      solverSettings: { maxIterations: 20000, tolerance: 1e-8 }
    });

    expect(response.status).toBe(200);
    const body = response.body as CoreSolveResult;
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      meshSource: "actual_volume_mesh",
      resultSource: "computed"
    });
    expect(body.surfaceMesh?.source).toBe("opencae_core_volume_mesh");
    expect(body.fields.find((field) => field.id === "stress-surface")?.values.length).toBe(body.surfaceMesh?.nodes.length);
    expect(body.diagnostics.some((diagnostic) => isDiagnostic(diagnostic, "core-cloud-mesh-generation"))).toBe(true);
  });

  test("solves procedural bracket dynamic geometry with multiple finite frames when Gmsh is available", async () => {
    const availability = await assertGmshAvailable();
    if (!availability.available) return;

    const response = await solveResponse({
      runId: "bracket-dynamic",
      analysisType: "dynamic_structural",
      study: {
        ...bracketStudy(),
        type: "dynamic_structural",
        solverSettings: {
          startTime: 0,
          endTime: 0.02,
          timeStep: 0.01,
          outputInterval: 0.01,
          dampingRatio: 0.02,
          loadProfile: "ramp"
        }
      },
      geometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm",
        descriptor: { meshSize: 28 }
      },
      solverSettings: { maxFrames: 5 }
    });

    expect(response.status).toBe(200);
    const fields = (response.body as CoreSolveResult).fields;
    const displacementFrames = fields.filter((field) => field.type === "displacement");
    expect(displacementFrames.length).toBeGreaterThan(1);
    expect(displacementFrames.flatMap((field) => field.values).every(Number.isFinite)).toBe(true);
  });

  test("Core Cloud source contains no legacy solver or file handoff path", () => {
    const srcRoot = resolve(__dirname, "../src");
    const sources = ["server.ts", "coreModelFromMesh.ts", "mesh/gmsh.ts", "geometry/bracket.ts", "geometry/structuredBlock.ts"]
      .map((file) => readFileSync(resolve(srcRoot, file), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/ccx|\.(?:inp|dat|frd)(?:["'`]|\b)/i);
    expect(sources.toLowerCase()).not.toContain(["calcu", "lix"].join(""));
  });
});

function bracketStudy() {
  return {
    id: "study-bracket",
    type: "static_stress",
    materialAssignments: [{ materialId: "mat-aluminum-6061" }],
    namedSelections: [
      {
        id: "FS1",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-base-left", label: "Base mounting holes" }]
      },
      {
        id: "L1",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-bracket", entityType: "face", entityId: "face-load-top", label: "Top load face" }]
      }
    ],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "FS1", parameters: {}, status: "complete" }],
    loads: [{ id: "load", type: "force", selectionRef: "L1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
    solverSettings: {}
  };
}

function isDiagnostic(value: unknown, id: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { id?: unknown }).id === id);
}
