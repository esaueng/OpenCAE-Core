import { describe, expect, test } from "vitest";
import {
  solverSurfaceMeshFromModel,
  validateCoreResult,
  type CoreSolveResult
} from "../src";
import { createSingleTetModel } from "./fixtures";

describe("Core result structures", () => {
  test("extracts a valid solver surface mesh from a volume model", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());

    expect(surfaceMesh.id).toBe("solver-surface");
    expect(surfaceMesh.source).toBe("opencae_core_volume_mesh");
    expect(surfaceMesh.coordinateSpace).toBe("solver");
    expect(surfaceMesh.nodes).toHaveLength(4);
    expect(surfaceMesh.triangles).toHaveLength(4);
    for (const triangle of surfaceMesh.triangles) {
      expect(triangle.every((node) => node >= 0 && node < surfaceMesh.nodes.length)).toBe(true);
    }
  });

  test("validates finite non-empty fields and surface mesh triangle references", () => {
    const result: CoreSolveResult = {
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
          id: "displacement",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2],
          min: 0,
          max: 0.2,
          units: "m",
          meshRef: "solver-surface"
        }
      ],
      surfaceMesh: solverSurfaceMeshFromModel(createSingleTetModel()),
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "m-N-s-Pa"
      }
    };

    expect(validateCoreResult(result).ok).toBe(true);
  });

  test("rejects empty fields, non-finite values, bad min/max, and invalid triangles", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: Number.POSITIVE_INFINITY,
        maxDisplacement: 0
      },
      fields: [
        {
          id: "empty",
          type: "stress",
          location: "element",
          values: [],
          min: 1,
          max: 0,
          units: "Pa"
        },
        {
          id: "bad-value",
          type: "velocity",
          location: "node",
          values: [Number.NaN],
          min: 0,
          max: 0,
          units: "m/s",
          frameIndex: 0
        }
      ],
      surfaceMesh: {
        id: "solver-surface",
        nodes: [[0, 0, 0]],
        triangles: [[0, 1, 2]],
        coordinateSpace: "solver",
        source: "opencae_core_volume_mesh"
      },
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "m-N-s-Pa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "non-finite-summary",
        "missing-summary-units",
        "empty-field-values",
        "invalid-field-range",
        "non-finite-field-value",
        "missing-frame-metadata",
        "invalid-surface-triangle-node"
      ])
    );
  });

  test("rejects Core results missing app-facing summary units and summary provenance", () => {
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxDisplacement: 0.1,
        reactionForce: 5
      } as CoreSolveResult["summary"],
      fields: [
        {
          id: "displacement",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2],
          min: 0,
          max: 0.2,
          units: "mm"
        }
      ],
      diagnostics: [],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh",
        units: "mm-N-s-MPa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["missing-summary-units", "missing-summary-provenance"])
    );
  });
});
