import { describe, expect, test } from "vitest";
import { normalizeModelJson } from "../src/normalize";
import { createSingleTetModel, createTwoTetModel } from "./fixtures";

describe("normalizeModelJson", () => {
  test("returns ok false when validation has errors", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].connectivity = [0, 1, 2, 99];

    const result = normalizeModelJson(model);

    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.report.errors.map((issue) => issue.code)).toContain("node-index-out-of-range");
  });

  test("normalizes typed arrays for a valid single-tet model", () => {
    const result = normalizeModelJson(createSingleTetModel());

    expect(result.ok).toBe(true);
    expect(result.model?.nodes.coordinates).toBeInstanceOf(Float64Array);
    expect(result.model?.elementBlocks[0].connectivity).toBeInstanceOf(Uint32Array);
    expect(result.model?.nodeSets[0].nodes).toBeInstanceOf(Uint32Array);
    expect(result.model?.elementSets[0].elements).toBeInstanceOf(Uint32Array);
  });

  test("resolves material names to material indices", () => {
    const result = normalizeModelJson(createTwoTetModel());

    expect(result.ok).toBe(true);
    expect(result.model?.elementBlocks.map((block) => block.materialIndex)).toEqual([0, 1]);
  });

  test("computes counts for a valid single-tet model", () => {
    const result = normalizeModelJson(createSingleTetModel());

    expect(result.model?.counts).toEqual({
      nodes: 4,
      elements: 1,
      materials: 1,
      nodeSets: 2,
      elementSets: 1,
      loads: 1,
      boundaryConditions: 2,
      steps: 1
    });
  });

  test("computes counts for a valid two-tet model", () => {
    const result = normalizeModelJson(createTwoTetModel());

    expect(result.model?.counts).toEqual({
      nodes: 5,
      elements: 2,
      materials: 2,
      nodeSets: 2,
      elementSets: 1,
      loads: 1,
      boundaryConditions: 2,
      steps: 1
    });
  });
});
