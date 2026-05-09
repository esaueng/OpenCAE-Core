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
    expect(surfaceMesh.nodeMap).toEqual([1, 2, 3, 0]);
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
          values: [0, 0.1, 0.2, 0.3],
          min: 0,
          max: 0.3,
          units: "m",
          surfaceMeshRef: "solver-surface"
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
        source: "opencae_core_volume_mesh",
        nodeMap: [0]
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

  test("rejects surface mesh fields that do not align one value per surface node", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "Pa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "m",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "m-N-s-Pa"
        }
      },
      fields: [
        {
          id: "surface-stress",
          type: "stress",
          location: "node",
          values: [1, 2, 3],
          min: 1,
          max: 3,
          units: "Pa",
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
        units: "m-N-s-Pa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("surface-field-length-mismatch");
  });

  test("rejects surface mesh fields with non-node location or misaligned vectors and samples", () => {
    const surfaceMesh = solverSurfaceMeshFromModel(createSingleTetModel());
    const result: CoreSolveResult = {
      summary: {
        maxStress: 10,
        maxStressUnits: "Pa",
        maxDisplacement: 0.1,
        maxDisplacementUnits: "m",
        reactionForce: 5,
        reactionForceUnits: "N",
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-sparse-tet",
          resultSource: "computed",
          meshSource: "actual_volume_mesh",
          units: "m-N-s-Pa"
        }
      },
      fields: [
        {
          id: "element-stress-on-surface",
          type: "stress",
          location: "element",
          values: [1, 2, 3, 4],
          min: 1,
          max: 4,
          units: "MPa",
          surfaceMeshRef: surfaceMesh.id
        },
        {
          id: "surface-displacement",
          type: "displacement",
          location: "node",
          values: [0, 0.1, 0.2, 0.3],
          vectors: [[0, 0, 0]],
          samples: [{ node: 0 }],
          min: 0,
          max: 0.3,
          units: "mm",
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
        units: "m-N-s-Pa"
      }
    };

    const report = validateCoreResult(result);

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "surface-field-location-mismatch",
        "surface-field-vector-length-mismatch",
        "surface-field-sample-length-mismatch"
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
