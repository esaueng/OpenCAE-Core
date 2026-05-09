import { describe, expect, test } from "vitest";
import { renderCpuSolveSummary } from "../src/app";
import type { StaticLinearTet4CpuSolveResult } from "@opencae/solver-cpu";

describe("renderCpuSolveSummary", () => {
  test("shows engineering max and plot max separately when they differ", () => {
    const result = {
      ok: true,
      diagnostics: {
        dofs: 12,
        freeDofs: 3,
        constrainedDofs: 9,
        relativeResidual: 0,
        maxDisplacement: 0.001,
        maxVonMisesStress: 12_000_000
      },
      result: {
        displacement: new Float64Array(),
        reactionForce: new Float64Array(),
        strain: new Float64Array(),
        stress: new Float64Array(),
        vonMises: new Float64Array([12_000_000]),
        coreResult: {
          summary: {
            maxStress: 12,
            maxStressUnits: "MPa",
            maxDisplacement: 1,
            maxDisplacementUnits: "mm",
            safetyFactor: 23,
            reactionForce: 500,
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
              values: [1, 8],
              min: 1,
              max: 8,
              units: "MPa",
              surfaceMeshRef: "solver-surface"
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
        }
      }
    } satisfies StaticLinearTet4CpuSolveResult;

    const html = renderCpuSolveSummary(result);

    expect(html).toContain("Engineering max");
    expect(html).toContain("Plot max");
    expect(html).toContain("1.2000e+1 MPa");
    expect(html).toContain("8.0000e+0 MPa");
  });
});
