import type { NormalizedOpenCAEModel } from "@opencae/core";
import { collectTetCoordinates } from "./element";
import { computeTet4Geometry } from "./geometry";

export function recoverNodalVonMisesFromElements(
  model: NormalizedOpenCAEModel,
  elementVonMises: ArrayLike<number>
): Float64Array {
  const nodalSum = new Float64Array(model.counts.nodes);
  const nodalWeight = new Float64Array(model.counts.nodes);
  let elementIndex = 0;

  for (const block of model.elementBlocks) {
    const nodesPerElement = block.type === "Tet10" ? 10 : 4;
    if (block.type !== "Tet4") {
      elementIndex += Math.floor(block.connectivity.length / nodesPerElement);
      continue;
    }

    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += 4) {
      const geometry = computeTet4Geometry(collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset));
      const weight = geometry.ok ? geometry.volume : 1;
      const value = elementVonMises[elementIndex] ?? 0;

      for (let localNode = 0; localNode < 4; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        nodalSum[node] += value * weight;
        nodalWeight[node] += weight;
      }
      elementIndex += 1;
    }
  }

  const nodalVonMises = new Float64Array(model.counts.nodes);
  for (let node = 0; node < nodalVonMises.length; node += 1) {
    nodalVonMises[node] = nodalWeight[node] > 0 ? nodalSum[node] / nodalWeight[node] : 0;
  }
  return nodalVonMises;
}
