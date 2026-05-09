import { singleTetStaticFixture } from "@opencae/examples";
import { describe, expect, test } from "vitest";
import { solveCoreStatic } from "@opencae/solver-cpu";
import { buildSolverSurfaceRenderGeometry } from "../src";

describe("buildSolverSurfaceRenderGeometry", () => {
  test("builds indexed geometry directly from solver surface fields", () => {
    const result = solveCoreStatic(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const geometry = buildSolverSurfaceRenderGeometry(result.result);
    const surfaceMesh = result.result.surfaceMesh!;
    const stressField = result.result.fields.find((field) => field.id === "stress-surface")!;

    expect(geometry.source).toBe("solver_surface_mesh");
    expect(geometry.surfaceMeshId).toBe(surfaceMesh.id);
    expect(geometry.positions).toHaveLength(surfaceMesh.nodes.length * 3);
    expect(geometry.indices).toHaveLength(surfaceMesh.triangles.length * 3);
    expect(geometry.values).toHaveLength(surfaceMesh.nodes.length);
    Array.from(geometry.values).forEach((value, index) => {
      expect(value).toBeCloseTo(stressField.values[index] ?? 0, 8);
    });
    expect(Array.from(geometry.nodeMap)).toEqual(surfaceMesh.nodeMap);
    expect(geometry.displacementVectors).toHaveLength(surfaceMesh.nodes.length * 3);
  });

  test("rejects surface fields that are not aligned to the solver surface", () => {
    const result = solveCoreStatic(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const badResult = {
      ...result.result,
      fields: result.result.fields.map((field) =>
        field.id === "stress-surface"
          ? { ...field, values: field.values.slice(1) }
          : field
      )
    };

    expect(() => buildSolverSurfaceRenderGeometry(badResult)).toThrow(/surface node count/i);
  });
});
