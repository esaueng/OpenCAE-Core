import type {
  BodyGravityLoadJson,
  LoadJson,
  NodalForceLoadJson,
  OpenCAEModelJson,
  PressureLoadJson,
  SurfaceFacetJson,
  SurfaceForceLoadJson,
  SurfaceSetJson
} from "./model-json";
import { elementNodeCount, extractBoundarySurfaceFacets, tet4Volume } from "./mesh";

export type LoadAssemblyError = {
  code: string;
  message: string;
  loadName?: string;
};

export type LoadAssemblyPerLoadDiagnostics = {
  name: string;
  type: LoadJson["type"];
  totalAppliedForce: [number, number, number];
  surfaceArea?: number;
  mass?: number;
};

export type LoadAssemblyDiagnostics = {
  totalAppliedForce: [number, number, number];
  loads: LoadAssemblyPerLoadDiagnostics[];
  errors: LoadAssemblyError[];
};

export type LoadAssemblyResult = {
  vector: Float64Array;
  diagnostics: LoadAssemblyDiagnostics;
};

export function assembleNodalLoadVector(model: OpenCAEModelJson, stepLoadNames: string[]): Float64Array {
  const result = assembleNodalLoadVectorWithDiagnostics(model, stepLoadNames);
  if (result.diagnostics.errors.length > 0) {
    throw new Error(
      `Load assembly failed: ${result.diagnostics.errors.map((error) => error.message).join("; ")}`
    );
  }
  return result.vector;
}

export function assembleNodalLoadVectorWithDiagnostics(
  model: OpenCAEModelJson,
  stepLoadNames: string[]
): LoadAssemblyResult {
  const vector = new Float64Array((model.nodes.coordinates.length / 3) * 3);
  const diagnostics: LoadAssemblyDiagnostics = {
    totalAppliedForce: [0, 0, 0],
    loads: [],
    errors: []
  };
  const loadByName = new Map(model.loads.map((load) => [load.name, load]));

  for (const loadName of stepLoadNames) {
    const load = loadByName.get(loadName);
    if (!load) {
      diagnostics.errors.push({
        code: "missing-load",
        loadName,
        message: `Load ${loadName} was not found.`
      });
      continue;
    }
    const loadTotal: [number, number, number] = [0, 0, 0];
    const loadDiagnostics: LoadAssemblyPerLoadDiagnostics = {
      name: load.name,
      type: load.type,
      totalAppliedForce: loadTotal
    };

    if (load.type === "nodalForce") {
      assembleNodalForce(model, vector, load, loadTotal, diagnostics);
    } else if (load.type === "surfaceForce") {
      loadDiagnostics.surfaceArea = assembleSurfaceForce(model, vector, load, loadTotal, diagnostics);
    } else if (load.type === "pressure") {
      loadDiagnostics.surfaceArea = assemblePressure(model, vector, load, loadTotal, diagnostics);
    } else if (load.type === "bodyGravity") {
      loadDiagnostics.mass = assembleBodyGravity(model, vector, load, loadTotal, diagnostics);
    } else {
      const unsupportedLoad = load as unknown as { name?: string; type?: string };
      diagnostics.errors.push({
        code: "unsupported-load-type",
        loadName: unsupportedLoad.name,
        message: `Load ${unsupportedLoad.name ?? "unknown"} has unsupported type ${unsupportedLoad.type ?? "unknown"}.`
      });
    }

    addVector(diagnostics.totalAppliedForce, loadTotal);
    diagnostics.loads.push(loadDiagnostics);
  }

  return { vector, diagnostics };
}

function assembleNodalForce(
  model: OpenCAEModelJson,
  vector: Float64Array,
  load: NodalForceLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): void {
  const nodeSet = model.nodeSets.find((set) => set.name === load.nodeSet);
  if (!nodeSet) {
    diagnostics.errors.push({
      code: "missing-node-set",
      loadName: load.name,
      message: `Load ${load.name} references missing node set ${load.nodeSet}.`
    });
    return;
  }

  for (const node of nodeSet.nodes) {
    addToNode(vector, node, load.vector);
    addVector(loadTotal, load.vector);
  }
}

function assembleSurfaceForce(
  model: OpenCAEModelJson,
  vector: Float64Array,
  load: SurfaceForceLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return 0;
  if (selection.area <= 0) {
    diagnostics.errors.push({
      code: "zero-surface-area",
      loadName: load.name,
      message: `Load ${load.name} references zero surface area set ${load.surfaceSet}.`
    });
    return selection.area;
  }

  for (const facet of selection.facets) {
    const area = facetArea(model, facet);
    if (area <= 0) continue;
    const facetForce = scaleVector(load.totalForce, area / selection.area);
    distributeToFacet(vector, facet, facetForce, loadTotal);
  }
  return selection.area;
}

function assemblePressure(
  model: OpenCAEModelJson,
  vector: Float64Array,
  load: PressureLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return 0;
  if (selection.area <= 0) {
    diagnostics.errors.push({
      code: "zero-surface-area",
      loadName: load.name,
      message: `Load ${load.name} references zero surface area set ${load.surfaceSet}.`
    });
    return selection.area;
  }

  for (const facet of selection.facets) {
    const geometry = facetGeometry(model, facet);
    if (geometry.area <= 0) {
      diagnostics.errors.push({
        code: "zero-surface-facet-area",
        loadName: load.name,
        message: `Load ${load.name} references zero area surface facet ${facet.id}.`
      });
      continue;
    }
    const direction = load.direction ?? geometry.normal;
    const facetForce = scaleVector(direction, load.pressure * geometry.area);
    distributeToFacet(vector, facet, facetForce, loadTotal);
  }
  return selection.area;
}

function assembleBodyGravity(
  model: OpenCAEModelJson,
  vector: Float64Array,
  load: BodyGravityLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const materialByName = new Map(model.materials.map((material) => [material.name, material]));
  let massTotal = 0;

  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") {
      diagnostics.errors.push({
        code: "unsupported-element-type",
        loadName: load.name,
        message: `Load ${load.name} bodyGravity only supports Tet4 elements; ${block.type} is unsupported.`
      });
      continue;
    }
    const material = materialByName.get(block.material);
    if (!material?.density || !Number.isFinite(material.density)) {
      diagnostics.errors.push({
        code: "missing-material-density",
        loadName: load.name,
        message: `Load ${load.name} requires density on material ${block.material}.`
      });
      continue;
    }

    const nodesPerElement = elementNodeCount(block.type);
    for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement) {
      const nodes = block.connectivity.slice(offset, offset + nodesPerElement);
      const volume = tet4Volume(model.nodes.coordinates, nodes);
      if (!Number.isFinite(volume) || volume <= 0) {
        diagnostics.errors.push({
          code: "non-positive-element-volume",
          loadName: load.name,
          message: `Load ${load.name} cannot assemble bodyGravity for non-positive Tet4 volume.`
        });
        continue;
      }
      const mass = material.density * volume;
      const elementForce = scaleVector(load.acceleration, mass);
      const nodalForce = scaleVector(elementForce, 1 / nodes.length);
      massTotal += mass;
      for (const node of nodes) {
        addToNode(vector, node, nodalForce);
      }
      addVector(loadTotal, elementForce);
    }
  }

  return massTotal;
}

function resolveSurfaceSelection(
  model: OpenCAEModelJson,
  surfaceSetName: string,
  loadName: string,
  diagnostics: LoadAssemblyDiagnostics
): { surfaceSet: SurfaceSetJson; facets: SurfaceFacetJson[]; area: number } | undefined {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === surfaceSetName);
  if (!surfaceSet) {
    diagnostics.errors.push({
      code: "missing-surface-set",
      loadName,
      message: `Load ${loadName} references missing surface set ${surfaceSetName}.`
    });
    return undefined;
  }

  const surfaceFacets = model.surfaceFacets ?? extractBoundarySurfaceFacets(model);
  const facetById = new Map(surfaceFacets.map((facet) => [facet.id, facet]));
  const facets: SurfaceFacetJson[] = [];
  let area = 0;

  for (const facetId of surfaceSet.facets) {
    const facet = facetById.get(facetId);
    if (!facet) {
      diagnostics.errors.push({
        code: "missing-surface-facet",
        loadName,
        message: `Load ${loadName} references missing surface facet ${facetId}.`
      });
      continue;
    }
    facets.push(facet);
    area += facetArea(model, facet);
  }

  return { surfaceSet, facets, area };
}

function distributeToFacet(
  vector: Float64Array,
  facet: SurfaceFacetJson,
  facetForce: [number, number, number],
  loadTotal: [number, number, number]
): void {
  const nodalForce = scaleVector(facetForce, 1 / facet.nodes.length);
  for (const node of facet.nodes) {
    addToNode(vector, node, nodalForce);
  }
  addVector(loadTotal, facetForce);
}

function facetArea(model: OpenCAEModelJson, facet: SurfaceFacetJson): number {
  return facet.area ?? facetGeometry(model, facet).area;
}

function facetGeometry(
  model: OpenCAEModelJson,
  facet: SurfaceFacetJson
): { area: number; normal: [number, number, number] } {
  const normal = facet.normal;
  const area = facet.area;
  if (area !== undefined && normal !== undefined) {
    return { area, normal };
  }

  const coordinates = model.nodes.coordinates;
  const ax = coordinateAt(coordinates, facet.nodes[0], 0);
  const ay = coordinateAt(coordinates, facet.nodes[0], 1);
  const az = coordinateAt(coordinates, facet.nodes[0], 2);
  const bx = coordinateAt(coordinates, facet.nodes[1], 0);
  const by = coordinateAt(coordinates, facet.nodes[1], 1);
  const bz = coordinateAt(coordinates, facet.nodes[1], 2);
  const cx = coordinateAt(coordinates, facet.nodes[2], 0);
  const cy = coordinateAt(coordinates, facet.nodes[2], 1);
  const cz = coordinateAt(coordinates, facet.nodes[2], 2);
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return {
    area: area ?? length / 2,
    normal: normal ?? (length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0])
  };
}

function addToNode(vector: Float64Array, node: number, force: [number, number, number]): void {
  vector[node * 3] += force[0];
  vector[node * 3 + 1] += force[1];
  vector[node * 3 + 2] += force[2];
}

function addVector(target: [number, number, number], value: [number, number, number]): void {
  target[0] += value[0];
  target[1] += value[1];
  target[2] += value[2];
}

function scaleVector(vector: [number, number, number], scale: number): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function coordinateAt(coordinates: ArrayLike<number>, node: number, component: number): number {
  return coordinates[node * 3 + component] ?? 0;
}
