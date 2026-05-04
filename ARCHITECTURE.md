# Architecture

OpenCAE Core is intended to run locally in the browser.

```text
web app
  ↓
solver worker
  ↓
core model package
  ↓
WebGPU solver package
  ↓
future Wasm fallback/reference package
  ↓
viewer package
```

Phase 0 creates the package boundaries and capability detection only. Solver data structures, numerical operators, GPU kernels, and visualization are intentionally out of scope.
