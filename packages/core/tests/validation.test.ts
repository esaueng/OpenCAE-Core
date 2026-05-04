import { describe, expect, test } from "vitest";
import { validateModelJson } from "../src/validation";
import { createSingleTetModel, createTwoTetModel } from "./fixtures";

describe("validateModelJson", () => {
  test("accepts a valid single-tet model", () => {
    expect(validateModelJson(createSingleTetModel())).toEqual({
      ok: true,
      errors: [],
      warnings: []
    });
  });

  test("accepts a valid two-tet model", () => {
    expect(validateModelJson(createTwoTetModel()).ok).toBe(true);
  });

  test("rejects invalid schema and schemaVersion", () => {
    const model = { ...createSingleTetModel(), schema: "wrong", schemaVersion: "9" };
    const report = validateModelJson(model);

    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual([
      "invalid-schema",
      "invalid-schema-version"
    ]);
  });

  test("rejects invalid node coordinates", () => {
    const model = createSingleTetModel();
    model.nodes.coordinates = [0, 0, 0, Number.NaN];

    const report = validateModelJson(model);

    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid-node-coordinate-length", "invalid-node-coordinate"])
    );
  });

  test("rejects invalid materials and duplicate material names", () => {
    const model = createSingleTetModel();
    model.materials = [
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: -1,
        poissonRatio: 0.5
      },
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: 1,
        poissonRatio: 0.3
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-young-modulus");
    expect(codes).toContain("invalid-poisson-ratio");
    expect(codes).toContain("duplicate-material-name");
  });

  test("rejects invalid Tet4 connectivity", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].connectivity = [0, 1, 1, 8, 2];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-connectivity-length");
    expect(codes).toContain("duplicate-tet-node");
    expect(codes).toContain("node-index-out-of-range");
  });

  test("rejects non-integer Tet4 connectivity and missing materials", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].material = "missing";
    model.elementBlocks[0].connectivity = [0, 1, 2, 1.5];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-material-reference");
    expect(codes).toContain("node-index-not-integer");
  });

  test("rejects invalid node sets and element sets", () => {
    const model = createSingleTetModel();
    model.nodeSets = [{ name: "badNodes", nodes: [0, 0, 99] }];
    model.elementSets = [{ name: "badElements", elements: [0, 0, 9] }];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("duplicate-node-set-index");
    expect(codes).toContain("node-set-index-out-of-range");
    expect(codes).toContain("duplicate-element-set-index");
    expect(codes).toContain("element-set-index-out-of-range");
  });

  test("rejects invalid boundary conditions", () => {
    const model = createSingleTetModel();
    model.boundaryConditions = [
      {
        name: "badFixed",
        type: "fixed",
        nodeSet: "missingNodes",
        components: ["x", "q"]
      },
      {
        name: "badValue",
        type: "prescribedDisplacement",
        nodeSet: "fixedNodes",
        component: "z",
        value: Number.POSITIVE_INFINITY
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-node-set-reference");
    expect(codes).toContain("invalid-component");
    expect(codes).toContain("invalid-prescribed-displacement-value");
  });

  test("rejects invalid loads", () => {
    const model = createSingleTetModel();
    model.loads = [
      {
        name: "badLoad",
        type: "nodalForce",
        nodeSet: "missingNodes",
        vector: [0, Number.NaN, 1]
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-node-set-reference");
    expect(codes).toContain("invalid-load-vector");
  });

  test("rejects invalid static step references", () => {
    const model = createSingleTetModel();
    model.steps = [
      {
        name: "badStep",
        type: "staticLinear",
        boundaryConditions: ["missingBc"],
        loads: ["missingLoad"]
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-boundary-condition-reference");
    expect(codes).toContain("missing-load-reference");
  });
});
