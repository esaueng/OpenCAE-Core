# OpenCAE Core Validation Suite

This document defines the Core validation suite for mesh-native OpenCAE models. The suite is intended to run without UI, Cloud FEA, React, or browser services.

## How To Run

```sh
pnpm --filter @opencae/core test
pnpm --filter @opencae/solver-cpu test
```

For compiler coverage:

```sh
pnpm --filter @opencae/core typecheck
pnpm --filter @opencae/solver-cpu typecheck
pnpm --filter @opencae/core build
pnpm --filter @opencae/solver-cpu build
```

## Supported Model Schema

The validation suite targets `opencae.model` schema `0.2.0`, while preserving compatibility with normalized `0.1.0` static Tet4 models.

Supported mesh-native primitives:

- Tet4 volume elements for CPU solving.
- Tet10 as schema-valid mesh data, currently rejected by the CPU solver with `unsupported-element-type`.
- Surface facets and surface sets for load application and result surface extraction.
- Node sets, element sets, fixed and prescribed-displacement boundary conditions.
- Nodal force, surface force, pressure, and body gravity loads.
- Static linear and dynamic linear steps.
- Material density and yield strength metadata.
- Solver coordinate metadata using `m-N-s-Pa` or `mm-N-s-MPa`.

## Solver Assumptions

The CPU reference solver assumes small-strain, linear isotropic elasticity on Tet4 meshes. The sparse static path assembles a CSR stiffness matrix and solves free DOFs with conjugate gradient. The dynamic MDOF path uses lumped Tet4 mass, optional Rayleigh damping, and Newmark average acceleration.

Constraints must remove rigid-body modes. Missing or insufficient constraints are expected to fail clearly, usually through a singular CG system.

Production APIs do not fall back to local estimates, display-bounds proxy solves, or preview dynamic scaling. A model that identifies its mesh source as a display-bounds proxy is rejected with:

```text
OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used.
```

Dynamic solves require density on every solved material. Missing density fails with:

```text
Dynamic solve requires material density.
```

## Static Benchmarks

The static validation suite covers:

- Axial bar tension: stress is checked against `F / A`, displacement against `F L / (A E)`, and reactions against the applied load.
- Cantilever beam: tip displacement and stress are compared to elementary beam theory with coarse Tet4 tolerance.
- Pressure patch: total load is checked as `pressure * selected surface area`.
- Body gravity: total reaction is checked as `density * volume * acceleration`.

The axial and load-balance checks use tight force-balance tolerances. The cantilever benchmark uses a deliberately coarse one-cell Tet4 mesh and only guards order-of-magnitude beam behavior. The documented tolerance is `0.05x` to `25x` of beam-theory displacement and stress, because this fixture is a regression guard for solver wiring, not a mesh-converged beam benchmark.

## Dynamic Benchmarks

The dynamic validation suite covers:

- Zero load remains zero for displacement, velocity, and acceleration.
- Ramp load has frame 0 near zero.
- Step load can produce immediate acceleration and early response.
- Half-sine load starts and ends at near-zero load scale.
- `outputInterval` controls emitted frame count.
- MDOF response changes across frames and is not a repeated static-copy sequence.
- Missing density fails.
- Excessive frame requests fail with a frame-budget diagnostic.

## Mesh Topology Requirements

Core mesh validation covers:

- Connected Tet meshes report one component.
- Disconnected Tet meshes report multiple components.
- Boundary surface facets can be extracted from volume connectivity.
- Surface sets map back to unique sorted node sets.
- Orphan nodes are detected.
- Solver surface meshes are derived from actual boundary facets.

Complex geometry must provide an actual connected volume mesh for Core solving. Display geometry, bounding boxes, or visual-only surface data are not enough.

## Bracket Regression Fixture

The validation suite includes a small bracket-like Tet mesh with:

- A base mount surface.
- An upright load surface.
- A triangular gusset/rib surface.
- A hole-wall style surface selection ID.

The regression requires:

- Volume mesh connected component count is `1`.
- Support and load surfaces are non-empty.
- Static sparse solve completes.
- Dynamic MDOF solve completes.
- Solver surface mesh topology stays connected.

This fixture is intentionally small. It validates topology, load routing, result surface extraction, and solver integration for non-block geometry. It is not a certified engineering benchmark.

## OpenCAE Core Cloud

The `services/opencae-core-cloud` package is the container-oriented Core Cloud runner. It exposes:

- `GET /health`
- `POST /solve`

The health response reports:

- `supportedAnalysisTypes: ["static_stress", "dynamic_structural"]`
- `supportedSolvers: ["sparse_static", "mdof_dynamic"]`
- `supportsActualVolumeMesh: true`
- `supportsPreview: false`
- `noCalculix: true`
- `noLocalEstimateFallback: true`

`POST /solve` validates an OpenCAE Core model, routes `static_stress` to `solveCoreStatic`, routes `dynamic_structural` to `solveCoreDynamic`, rejects preview requests, and returns a `CoreSolveResult`.

## Known Limitations

- CPU solving currently supports Tet4 only.
- Tet10 is retained in schema and mesh topology utilities but rejected by the CPU solver.
- The sparse static solver uses CG and expects a symmetric positive-definite constrained system.
- Contact, tie, multi-part interaction, large deformation, plasticity, thermal loading, and nonlinear material behavior are not implemented.
- The preview SDOF dynamic solver remains available only for legacy preview behavior. Complex Core FEA should use the MDOF dynamic solver.
- The validation benchmarks are regression tests for Core behavior. They are not a substitute for mesh convergence, verification against reference solvers, or engineering certification.
