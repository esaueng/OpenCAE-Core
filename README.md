# OpenCAE Core

OpenCAE Core provides mesh-native model validation, load assembly, CPU reference solving, and Core-native result structures for browser-local FEA workflows.

## Model v0.2

`@opencae/core` exports the `opencae.model` schema constants and TypeScript model types for schema `0.2.0`.

Schema `0.2.0` supports:

- Tet4 and Tet10 element blocks.
- Surface facets and surface sets.
- Node sets and element sets.
- Fixed and prescribed-displacement boundary conditions.
- Nodal force, surface force, pressure, and body gravity loads.
- Static linear and dynamic linear steps.
- Material density and yield strength metadata.
- Coordinate-system metadata.

Legacy `0.1.0` Tet4 static models remain supported through normalization.

```ts
import {
  OPENCAE_MODEL_SCHEMA_VERSION,
  normalizeModelJson,
  validateModelJson
} from "@opencae/core";
```

## Static Solve API

Use `solveCoreStatic` from `@opencae/solver-cpu` when an app or adapter wants a stable Core result object instead of solver-internal arrays.

```ts
import { solveCoreStatic } from "@opencae/solver-cpu";

const solved = solveCoreStatic(model, { method: "auto" });
if (solved.ok) {
  const result = solved.result; // CoreSolveResult
}
```

The static API validates and normalizes the model, selects dense or sparse solving, and returns a `CoreSolveResult` with fields, summary, diagnostics, provenance, and solver surface mesh output.

Lower-level static APIs remain exported for reference and tests:

- `solveStaticLinearTet4Cpu`
- `solveStaticLinearTetSparse`
- `solveStaticLinearTet`

## Dynamic Solve API

Use `solveCoreDynamic` for production dynamic FEA. It calls the true MDOF Newmark solver and returns a frame-aware `CoreSolveResult`.

```ts
import { solveCoreDynamic } from "@opencae/solver-cpu";

const solved = solveCoreDynamic(model, { stepIndex: 0 });
if (solved.ok) {
  for (const field of solved.result.fields) {
    // Dynamic fields include frameIndex and timeSeconds.
  }
}
```

Production dynamic solving requires material density. It fails clearly instead of falling back to preview behavior.

Production result provenance is restricted to OpenCAE Core FEA:

- `kind: "opencae_core_fea"`
- `resultSource: "computed"`
- `solver: "opencae-core-sparse-tet"` or `solver: "opencae-core-mdof-tet"`

If a complex model only has a display-bounds proxy instead of actual volume mesh data, production APIs fail with:

```text
OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used.
```

## Preview Solver API

The legacy equivalent-SDOF dynamic approximation is available only through preview-named APIs:

```ts
import { solveCorePreviewDynamic } from "@opencae/solver-cpu";
```

Preview results use the `PreviewDynamicResult` type and are marked with `resultSource: "computed_preview"`. Do not use preview dynamic results for complex Core FEA.

## OpenCAE Core Cloud

This repo includes `@opencae/core-cloud`, a minimal Node service under `services/opencae-core-cloud` that runs the same Core model validation and `@opencae/solver-cpu` engines in a container.

Endpoints:

- `GET /health`
- `POST /solve`

`/solve` accepts `static_stress` and `dynamic_structural` analysis types. It rejects preview requests, invalid Core models, and display-proxy mesh sources. The cloud runner does not generate input decks, invoke external FEA engines, or fall back to local estimates.

## Validation Suite

The validation suite covers mesh topology, load assembly, static sparse solving, MDOF dynamics, result validation, and a bracket-like connected mesh regression.

```sh
pnpm --filter @opencae/core test
pnpm --filter @opencae/solver-cpu test
```

See [docs/validation/core.md](docs/validation/core.md) for benchmark assumptions, tolerances, and limitations.

## Limitations

- CPU solving currently supports Tet4 elements only.
- Tet10 is schema-valid but rejected by the CPU solver.
- Contact, tie, nonlinear material behavior, plasticity, large deformation, thermal loading, and fracture are not implemented.
- The sparse static solver expects constrained symmetric positive-definite systems.
- Dynamic MDOF solving uses lumped mass and Newmark average acceleration.
- Validation benchmarks are regression tests, not engineering certification.
