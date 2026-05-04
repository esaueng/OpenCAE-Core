export const PLACEHOLDER_MODEL_FIXTURE = "fixtures/placeholder-model.json";
import type { OpenCAEModelJson } from "@opencae/core";

export const singleTetStaticFixture = {
  schema: "opencae.model",
  schemaVersion: "0.1.0",
  nodes: {
    coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  },
  materials: [
    {
      name: "steel",
      type: "isotropicLinearElastic",
      youngModulus: 210000000000,
      poissonRatio: 0.3
    }
  ],
  elementBlocks: [
    {
      name: "tetrahedra",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 2, 3]
    }
  ],
  nodeSets: [
    {
      name: "fixedNodes",
      nodes: [0]
    },
    {
      name: "loadNodes",
      nodes: [3]
    },
    {
      name: "supportYNodes",
      nodes: [1]
    },
    {
      name: "supportZNodes",
      nodes: [2]
    }
  ],
  elementSets: [
    {
      name: "allElements",
      elements: [0]
    }
  ],
  boundaryConditions: [
    {
      name: "fixedSupport",
      type: "fixed",
      nodeSet: "fixedNodes",
      components: ["x", "y", "z"]
    },
    {
      name: "settlement",
      type: "prescribedDisplacement",
      nodeSet: "fixedNodes",
      component: "z",
      value: 0
    },
    {
      name: "supportY",
      type: "fixed",
      nodeSet: "supportYNodes",
      components: ["y", "z"]
    },
    {
      name: "supportZ",
      type: "fixed",
      nodeSet: "supportZNodes",
      components: ["z"]
    }
  ],
  loads: [
    {
      name: "tipLoad",
      type: "nodalForce",
      nodeSet: "loadNodes",
      vector: [0, 0, -100]
    }
  ],
  steps: [
    {
      name: "loadStep",
      type: "staticLinear",
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      loads: ["tipLoad"]
    }
  ]
} satisfies OpenCAEModelJson;

export const twoTetStaticFixture = {
  ...singleTetStaticFixture,
  nodes: {
    coordinates: [...singleTetStaticFixture.nodes.coordinates, 1, 1, 1]
  },
  materials: [
    ...singleTetStaticFixture.materials,
    {
      name: "aluminum",
      type: "isotropicLinearElastic",
      youngModulus: 70000000000,
      poissonRatio: 0.33
    }
  ],
  elementBlocks: [
    {
      name: "firstBlock",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 2, 3]
    },
    {
      name: "secondBlock",
      type: "Tet4",
      material: "aluminum",
      connectivity: [1, 2, 3, 4]
    }
  ],
  nodeSets: [
    {
      name: "fixedNodes",
      nodes: [0]
    },
    {
      name: "loadNodes",
      nodes: [4]
    },
    {
      name: "supportYNodes",
      nodes: [1]
    },
    {
      name: "supportZNodes",
      nodes: [2]
    }
  ],
  elementSets: [
    {
      name: "allElements",
      elements: [0, 1]
    }
  ],
  boundaryConditions: [
    {
      name: "fixedSupport",
      type: "fixed",
      nodeSet: "fixedNodes",
      components: ["x", "y", "z"]
    },
    {
      name: "supportY",
      type: "fixed",
      nodeSet: "supportYNodes",
      components: ["y", "z"]
    },
    {
      name: "supportZ",
      type: "fixed",
      nodeSet: "supportZNodes",
      components: ["z"]
    }
  ],
  steps: [
    {
      name: "loadStep",
      type: "staticLinear",
      boundaryConditions: ["fixedSupport", "supportY", "supportZ"],
      loads: ["tipLoad"]
    }
  ]
} satisfies OpenCAEModelJson;

export const invalidConnectivityFixture = {
  ...singleTetStaticFixture,
  elementBlocks: [
    {
      name: "tetrahedra",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 1, 9, 2]
    }
  ],
  elementSets: []
} satisfies OpenCAEModelJson;

export const phase1FixturePaths = {
  singleTetStatic: "fixtures/single-tet-static.json",
  twoTetStatic: "fixtures/two-tet-static.json",
  invalidConnectivity: "fixtures/invalid-connectivity.json"
} as const;
