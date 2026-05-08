import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import { validateCoreResult, type OpenCAEModelJson } from "@opencae/core";
import {
  solveCoreDynamic,
  solveCorePreviewDynamic,
  solveCoreStatic,
  solveDynamicTet4Cpu,
  solveStaticLinearTet,
  solveStaticLinearTetSparse
} from "../src";

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

describe("public Core solver APIs", () => {
  test("exports stable static solver entrypoints", () => {
    expect(typeof solveStaticLinearTet).toBe("function");
    expect(typeof solveStaticLinearTetSparse).toBe("function");
    expect(typeof solveCoreStatic).toBe("function");
  });

  test("solveCoreStatic returns a validated CoreSolveResult", () => {
    const result = solveCoreStatic(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.provenance.resultSource).toBe("computed");
    expect(result.result.provenance.solver).toBe("opencae-core-sparse-tet");
    expect(result.result.provenance.kind).toBe("opencae_core_fea");
    expect(result.result.fields.map((field) => field.type)).toEqual(expect.arrayContaining(["displacement", "stress"]));
    expect(JSON.stringify(result.result)).not.toContain("local_estimate");
    expect(JSON.stringify(result.result)).not.toContain("computed_preview");
    expect(validateCoreResult(result.result).ok).toBe(true);
  });

  test("solveCoreDynamic returns MDOF CoreSolveResult and never preview by default", () => {
    const result = solveCoreDynamic(densityModel);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.provenance.resultSource).toBe("computed");
    expect(result.result.provenance.kind).toBe("opencae_core_fea");
    expect(result.result.provenance.solver).toBe("opencae-core-mdof-tet");
    expect(result.diagnostics.solver).toBe("opencae-core-mdof-newmark");
    expect(result.result.summary.transient?.frameCount).toBeGreaterThan(1);
    expect(JSON.stringify(result.result)).not.toContain("local_estimate");
    expect(JSON.stringify(result.result)).not.toContain("computed_preview");
    expect(validateCoreResult(result.result).ok).toBe(true);
  });

  test("production APIs reject display proxy mesh sources without estimate fallback", () => {
    const proxyModel: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "display_bounds_proxy"
      }
    };

    const result = solveCoreStatic(proxyModel);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toBe(
      "OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used."
    );
  });

  test("production dynamic API requires dynamicLinear steps", () => {
    const result = solveCoreDynamic({
      ...densityModel,
      steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedSupport"], loads: ["tipLoad"] }]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("invalid-dynamic-step");
  });

  test("production dynamic solve fails instead of silently falling back to preview", () => {
    const noDensityDynamic: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      steps: densityModel.steps
    };

    const result = solveCoreDynamic(noDensityDynamic);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toContain("Dynamic solve requires material density.");
  });

  test("preview dynamic solver requires explicit preview call", () => {
    const preview = solveCorePreviewDynamic(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });
    const legacyPreview = solveDynamicTet4Cpu(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(preview.ok).toBe(true);
    expect(legacyPreview.ok).toBe(true);
    if (!preview.ok || !legacyPreview.ok) return;
    expect(preview.result.provenance?.resultSource).toBe("computed_preview");
    expect(preview.diagnostics.solver).toBe("opencae-core-preview-sdof");
    expect(legacyPreview.diagnostics.solver).toBe("opencae-core-preview-sdof");
  });
});
