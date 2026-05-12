import { describe, expect, test } from "vitest";
import { nodeSetFromSurfaceSet, validateModelJson, type CoreSolveResult } from "@opencae/core";
import { solveCoreStatic } from "@opencae/solver-cpu";
import { modelForRequest, solveResponse } from "../src/server";
import type { CoreCloudSolveRequest } from "../src/types";

describe("Core Cloud geometry intake", () => {
  test("modelForRequest builds a Core model from structured block geometry", async () => {
    const candidate = await modelForRequest(cantileverGeometryRequest({
      geometry: {
        kind: "structured_block",
        sampleId: "cantilever",
        units: "mm",
        descriptor: { dimensions: { length: 180, width: 24, height: 24 } }
      }
    }));

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;

    expect(validateModelJson(candidate.model).ok).toBe(true);
    expect(candidate.model.meshProvenance).toMatchObject({
      meshSource: "structured_block_core",
      solver: "opencae-core-cloud",
      resultSource: "computed"
    });
    expect(Math.max(...xCoordinates(candidate.model.nodes.coordinates))).toBeCloseTo(0.18);
    expect(candidate.model.surfaceSets?.find((set) => set.name === "x_min")?.facets.length).toBeGreaterThan(0);
    expect(candidate.model.surfaceSets?.find((set) => set.name === "x_max")?.facets.length).toBeGreaterThan(0);

    const fixedSet = candidate.model.surfaceSets?.find((set) => set.name === "fixed_support");
    const loadSet = candidate.model.surfaceSets?.find((set) => set.name === "load_surface");
    expect(fixedSet?.facets.length).toBeGreaterThan(0);
    expect(loadSet?.facets.length).toBeGreaterThan(0);
    expect(nodeSetFromSurfaceSet(fixedSet!, candidate.model.surfaceFacets ?? []).length).toBeGreaterThan(0);
    expect(candidate.meshDiagnostics).toEqual(expect.anything());
  });

  test("modelForRequest builds a Core model from cantilever sample geometry", async () => {
    const candidate = await modelForRequest(cantileverGeometryRequest({
      geometry: {
        kind: "sample_procedural",
        sampleId: "cantilever",
        units: "mm",
        descriptor: { dimensions: { length: 180, width: 24, height: 24 } }
      }
    }));

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(validateModelJson(candidate.model).ok).toBe(true);
    expect(candidate.model.loads[0]).toMatchObject({ type: "surfaceForce", surfaceSet: "load_surface" });
  });

  test("modelForRequest reports missing model mesh or geometry", async () => {
    const candidate = await modelForRequest({ analysisType: "static_stress" });

    expect(candidate).toMatchObject({
      ok: false,
      issue: {
        code: "missing-core-model-or-geometry",
        message: "OpenCAE Core Cloud requires coreModel, coreVolumeMesh, or geometry. No local estimate fallback was used.",
        path: "$"
      }
    });
  });

  test("generated cantilever model solves and balances reaction force", async () => {
    const candidate = await modelForRequest(cantileverGeometryRequest({
      geometry: {
        kind: "sample_procedural",
        sampleId: "cantilever",
        units: "mm",
        descriptor: { dimensions: { length: 180, width: 24, height: 24 } }
      }
    }));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;

    const solved = solveCoreStatic(candidate.model, { method: "sparse", solverMode: "sparse", maxIterations: 10000, tolerance: 1e-8 });

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.reactionBalance?.relativeError).toBeLessThan(1e-6);
    expect(solved.diagnostics.maxDisplacement).toBeGreaterThan(0);
    expect(solved.diagnostics.maxVonMisesStress).toBeGreaterThan(0);
    expect(solved.result.surfaceMesh?.nodes.length).toBeGreaterThan(0);
    expect(solved.result.fields.find((field) => field.id === "stress-surface")?.values.length).toBe(solved.result.surfaceMesh?.nodes.length);
  });

  test("geometry solve response includes phase diagnostics from model generation through solve", async () => {
    const response = await solveResponse(cantileverGeometryRequest({
      runId: "cantilever-geometry",
      geometry: {
        kind: "sample_procedural",
        sampleId: "cantilever",
        units: "mm",
        descriptor: { dimensions: { length: 180, width: 24, height: 24 } }
      }
    }));

    expect(response.status).toBe(200);
    const body = response.body as CoreSolveResult;
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "structured-block-model-generated", phase: "geometry_to_core_model" }),
        expect.objectContaining({ phase: "validation" }),
        expect.objectContaining({ phase: "solve" }),
        expect.objectContaining({ phase: "postprocess" })
      ])
    );
  });

  test("unsupported bracket geometry returns a specific meshing diagnostic when unavailable", async () => {
    const candidate = await modelForRequest(cantileverGeometryRequest({
      geometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm"
      }
    }));

    if (candidate.ok) return;
    expect(candidate.issue).toMatchObject({
      code: expect.any(String),
      message: expect.stringContaining("No local estimate fallback was used"),
      path: "$.geometry"
    });
  });

  test("empty structured block load mapping returns a surface_mapping diagnostic", async () => {
    const response = await solveResponse(cantileverGeometryRequest({
      geometry: {
        kind: "structured_block",
        sampleId: "cantilever",
        units: "mm",
        descriptor: {
          dimensions: { length: 180, width: 24, height: 24 },
          loadFace: "not_a_face"
        }
      }
    }));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "load-surface-empty",
          phase: "surface_mapping",
          message: "Load selection L1 did not map to any structured block surface facets.",
          path: "$.study.loads[0].selectionRef"
        })
      ])
    });
  });
});

function cantileverGeometryRequest(overrides: Partial<CoreCloudSolveRequest> = {}): CoreCloudSolveRequest {
  return {
    analysisType: "static_stress",
    study: {
      id: "study-cantilever",
      type: "static_stress",
      materialAssignments: [{ materialId: "mat-aluminum-6061" }],
      namedSelections: [
        {
          id: "FS1",
          name: "Fixed support",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: "x_min", label: "Fixed support" }]
        },
        {
          id: "L1",
          name: "Load surface",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: "x_max", label: "Load surface" }]
        }
      ],
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "FS1", parameters: {} }],
      loads: [{ id: "load", type: "force", selectionRef: "L1", parameters: { value: 500, units: "N", direction: [0, -1, 0] } }],
      solverSettings: {}
    },
    solverSettings: { maxIterations: 10000, tolerance: 1e-8 },
    ...overrides
  };
}

function xCoordinates(coordinates: number[]): number[] {
  const xs: number[] = [];
  for (let index = 0; index < coordinates.length; index += 3) {
    xs.push(coordinates[index]!);
  }
  return xs;
}
