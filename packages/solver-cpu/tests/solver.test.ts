import { describe, expect, test } from "vitest";
import {
  invalidConnectivityFixture,
  singleTetStaticFixture,
  twoTetStaticFixture
} from "@opencae/examples";
import type { OpenCAEModelJson } from "@opencae/core";
import { solveStaticLinearTet4Cpu } from "../src";

describe("solveStaticLinearTet4Cpu", () => {
  test("solves single-tet-static", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement.length).toBe(12);
    expect(result.result.reactionForce.length).toBe(12);
    expect(result.result.strain.length).toBe(6);
    expect(result.result.stress.length).toBe(6);
    expect(result.result.vonMises.length).toBe(1);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
    expect(result.diagnostics.dofs).toBe(12);
    expect(result.diagnostics.constrainedDofs).toBeGreaterThan(0);
    expect(result.diagnostics.freeDofs).toBeGreaterThan(0);
  });

  test("solves two-tet-static", () => {
    const result = solveStaticLinearTet4Cpu(twoTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.strain.length).toBe(12);
    expect(result.result.stress.length).toBe(12);
    expect(result.result.vonMises.length).toBe(2);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });

  test("returns ok false for invalid connectivity", () => {
    const result = solveStaticLinearTet4Cpu(invalidConnectivityFixture);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("validation-failed");
  });

  test("keeps fixed DOFs at zero and finite reactions", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement[0]).toBeCloseTo(0, 14);
    expect(result.result.displacement[1]).toBeCloseTo(0, 14);
    expect(result.result.displacement[2]).toBeCloseTo(0, 14);
    expect(Array.from(result.result.reactionForce).every(Number.isFinite)).toBe(true);
  });

  test("fails when maxDofs is exceeded", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture, { maxDofs: 3 });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("max-dofs-exceeded");
  });

  test("fails for singular or underconstrained models", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: [],
          loads: ["tipLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("singular-system");
  });

  test("fails for conflicting prescribed displacements", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [
        ...singleTetStaticFixture.boundaryConditions,
        {
          name: "conflict",
          type: "prescribedDisplacement",
          nodeSet: "fixedNodes",
          component: "z",
          value: 1
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "conflict"],
          loads: ["tipLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("conflicting-prescribed-displacement");
  });
});
