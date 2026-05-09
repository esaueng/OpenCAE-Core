# OpenCAE Core Validation

See [core.md](./core.md) for the runnable Core validation suite, solver benchmark tolerances, mesh-quality requirements, and current solver limitations.

OpenCAE Core solves the volume mesh supplied in the model JSON. Complex geometry must provide an actual Tet4 volume mesh with surface facets and surface sets. Core must not create or solve a rectangular display-bounds proxy for brackets, holes, ribs, gussets, uploaded CAD, or other non-block shapes.

If a complex display model has no actual volume mesh, preflight should fail with:

```text
OpenCAE Core requires an actual volume mesh for complex geometry. Use Cloud FEA or generate a Core mesh.
```

## Model Schema

Schema `0.2.0` adds Tet4/Tet10 element blocks, surface facets, surface sets, surface force and pressure loads, dynamic linear steps, coordinate metadata, mesh provenance, and optional mesh connection metadata. Legacy `0.1.0` Tet4/static/nodal-force models still validate and normalize internally to `0.2.0`.

Tet10 is currently schema-valid only. `@opencae/solver-cpu` returns `unsupported-element-type` for Tet10 instead of downgrading it to Tet4.

## Mesh Preflight

Validation rejects invalid node indices, invalid connectivity, empty node or surface sets, orphan surface facets, missing load/BC/step references, non-positive Tet4 volume, unsupported element types, and disconnected bodies without `meshConnections`.

For a fused single-solid fixture, `connectedComponents(mesh).componentCount` must be `1`. If a mesh has multiple disconnected bodies, callers must provide explicit tie/contact/fuse metadata or route the job to a solver that supports the intended contact model.

## Loads And Results

Surface force loads are distributed over selected facets by area, then to each facet node. Pressure loads use `pressure * facet area` along an explicit direction or the facet normal. The assembled nodal forces must balance reactions within solver tolerance.

Accurate result visualization should use the solver surface mesh returned by Core metadata. `surfaceMesh.nodeMap` maps each surface node back to the volume mesh node id. Surface visualization fields use `surfaceMeshRef` and must contain one value per surface node, so downstream viewers can render and deform the solved topology instead of projecting values onto unrelated display primitives.

Engineering values remain separate from visualization values. `summary.maxStress` is based on raw element von Mises stress, while the surface stress field is a recovered nodal field marked with `visualizationSource: "nodal_recovered_surface_average"` and `engineeringSource: "element_von_mises"`.

Core emits a `stress-visualization` diagnostic with the engineering max, plot min/max, recovery method, smoothing pass count, surface mesh counts, field count, fixed/load centroids, and effective lever arm. This diagnostic is for renderer/debug visibility; safety factor and engineering max still use raw element stress.

## Downstream Adapter Contract

The consuming app adapter should use these paths:

- Use `actualCoreMesh` directly when present.
- Convert Cloud FEA/Gmsh, uploaded mesh, procedural fixture, or future browser mesher output with `volumeMeshToModelJson`.
- Use structured block meshes only for simple one-body rectangular cantilever/block/beam display models.
- Reject complex geometry without actual mesh and route to Cloud FEA or mesh generation.
