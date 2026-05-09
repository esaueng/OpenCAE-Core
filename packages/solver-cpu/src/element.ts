import { computeTet4Geometry } from "./geometry";
import type { NormalizedOpenCAEModel } from "@opencae/core";
import type { Tet4ElementStiffnessResult, Tet4GeometryResult } from "./types";

export function computeTet4BMatrix(gradients: Float64Array): Float64Array {
  const b = new Float64Array(72);
  for (let node = 0; node < 4; node += 1) {
    const gx = gradients[node * 3];
    const gy = gradients[node * 3 + 1];
    const gz = gradients[node * 3 + 2];
    const col = node * 3;

    b[col] = gx;
    b[12 + col + 1] = gy;
    b[24 + col + 2] = gz;
    b[36 + col] = gy;
    b[36 + col + 1] = gx;
    b[48 + col + 1] = gz;
    b[48 + col + 2] = gy;
    b[60 + col] = gz;
    b[60 + col + 2] = gx;
  }
  return b;
}

export function computeTet4ElementStiffness(
  geometry: Tet4GeometryResult,
  dMatrix: Float64Array
): Tet4ElementStiffnessResult {
  if (!geometry.ok) {
    return geometry;
  }

  const b = computeTet4BMatrix(geometry.gradients);
  const db = new Float64Array(72);
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      let value = 0;
      for (let k = 0; k < 6; k += 1) {
        value += dMatrix[row * 6 + k] * b[k * 12 + col];
      }
      db[row * 12 + col] = value;
    }
  }

  const stiffness = new Float64Array(144);
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      let value = 0;
      for (let k = 0; k < 6; k += 1) {
        value += b[k * 12 + row] * db[k * 12 + col];
      }
      stiffness[row * 12 + col] = value * geometry.volume;
    }
  }

  return {
    ok: true,
    stiffness
  };
}

export function recoverTet4Strain(gradients: Float64Array, elementDisplacement: Float64Array): Float64Array {
  const b = computeTet4BMatrix(gradients);
  const strain = new Float64Array(6);
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      strain[row] += b[row * 12 + col] * elementDisplacement[col];
    }
  }
  return strain;
}

export function recoverStress(dMatrix: Float64Array, strain: Float64Array): Float64Array {
  const stress = new Float64Array(6);
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      stress[row] += dMatrix[row * 6 + col] * strain[col];
    }
  }
  return stress;
}

export function computeVonMisesStress(stress: ArrayLike<number>): number {
  const sxx = stress[0];
  const syy = stress[1];
  const szz = stress[2];
  const sxy = stress[3];
  const syz = stress[4];
  const sxz = stress[5];
  return Math.sqrt(
    0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) +
      3 * (sxy ** 2 + syz ** 2 + sxz ** 2)
  );
}

export function collectTetCoordinates(
  coordinates: Float64Array,
  connectivity: Uint32Array,
  elementOffset: number
): Float64Array {
  const tetCoordinates = new Float64Array(12);
  for (let localNode = 0; localNode < 4; localNode += 1) {
    const node = connectivity[elementOffset + localNode];
    tetCoordinates[localNode * 3] = coordinates[node * 3];
    tetCoordinates[localNode * 3 + 1] = coordinates[node * 3 + 1];
    tetCoordinates[localNode * 3 + 2] = coordinates[node * 3 + 2];
  }
  return tetCoordinates;
}

export function recoverNodalVonMisesFromElements(
  model: NormalizedOpenCAEModel,
  elementVonMises: ArrayLike<number>,
  options: { surfaceOnly?: boolean } = {}
): Float64Array {
  const nodalValues = new Float64Array(model.counts.nodes);
  const weights = new Float64Array(model.counts.nodes);
  const surfaceNodes = options.surfaceOnly ? collectSurfaceNodes(model) : undefined;
  let elementIndex = 0;

  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") {
      elementIndex += Math.floor(block.connectivity.length / (block.type === "Tet10" ? 10 : 4));
      continue;
    }
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += 4) {
      const geometry = computeTet4Geometry(collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset));
      const weight = geometry.ok ? geometry.volume : 1;
      const value = elementVonMises[elementIndex] ?? 0;
      for (let localNode = 0; localNode < 4; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        if (surfaceNodes && !surfaceNodes.has(node)) continue;
        nodalValues[node] += value * weight;
        weights[node] += weight;
      }
      elementIndex += 1;
    }
  }

  for (let node = 0; node < nodalValues.length; node += 1) {
    if (weights[node] > 0) nodalValues[node] /= weights[node];
  }
  return nodalValues;
}

export function smoothNodalScalarField(
  model: NormalizedOpenCAEModel,
  nodalValues: ArrayLike<number>,
  iterations: number
): Float64Array {
  let current = Float64Array.from(nodalValues);
  const adjacency = nodeAdjacency(model);
  const count = Math.max(0, Math.floor(iterations));

  for (let iteration = 0; iteration < count; iteration += 1) {
    const next = new Float64Array(current.length);
    for (let node = 0; node < current.length; node += 1) {
      let sum = current[node];
      let samples = 1;
      for (const neighbor of adjacency[node] ?? []) {
        sum += current[neighbor];
        samples += 1;
      }
      next[node] = sum / samples;
    }
    current = next;
  }

  return current;
}

function collectSurfaceNodes(model: NormalizedOpenCAEModel): Set<number> {
  const nodes = new Set<number>();
  for (const facet of model.surfaceFacets) {
    for (const node of facet.nodes) nodes.add(node);
  }
  return nodes;
}

function nodeAdjacency(model: NormalizedOpenCAEModel): Set<number>[] {
  const adjacency = Array.from({ length: model.counts.nodes }, () => new Set<number>());
  for (const block of model.elementBlocks) {
    const nodesPerElement = block.type === "Tet10" ? 10 : 4;
    for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement) {
      const nodes = Array.from(block.connectivity.slice(offset, offset + nodesPerElement));
      for (const node of nodes) {
        for (const neighbor of nodes) {
          if (neighbor !== node) adjacency[node].add(neighbor);
        }
      }
    }
  }
  return adjacency;
}

export { computeTet4Geometry };
