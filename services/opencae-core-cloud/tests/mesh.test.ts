import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { connectedComponents, validateModelJson } from "@opencae/core";
import { generateBracketCoreVolumeMesh, bracketGeometrySourceMetadata } from "../src/geometry/bracket";
import { generateStructuredBlockCoreVolumeMesh } from "../src/geometry/structuredBlock";
import { buildCoreModelFromCloudMesh, mapSelectionToSurfaceSet } from "../src/coreModelFromMesh";
import { assertGmshAvailable, parseGmshMeshToCoreVolumeMesh } from "../src/mesh/gmsh";

const aluminumStudy = {
  id: "study-bracket-static",
  type: "static_stress",
  materialAssignments: [{ materialId: "mat-aluminum-6061" }],
  namedSelections: [
    {
      id: "FS1",
      entityType: "face",
      geometryRefs: [{ entityType: "face", entityId: "face-base-left", bodyId: "body-bracket", label: "Base mounting holes" }]
    },
    {
      id: "L1",
      entityType: "face",
      geometryRefs: [{ entityType: "face", entityId: "face-load-top", bodyId: "body-bracket", label: "Top load face" }]
    }
  ],
  constraints: [{ id: "fixed", type: "fixed", selectionRef: "FS1", parameters: {} }],
  loads: [{ id: "load", type: "force", selectionRef: "L1", parameters: { value: 500, units: "N", direction: [0, -1, 0] } }],
  solverSettings: {}
};

describe("Core Cloud volume mesh generation", () => {
  test("parses MSH 2.2 Tet4 and physical surfaces into a Core volume mesh artifact", () => {
    const mesh = parseGmshMeshToCoreVolumeMesh(sampleMsh(), {
      units: "mm",
      sourceSelectionRefs: {
        fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
        load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" }
      }
    });

    expect(mesh.nodes.coordinates).toHaveLength(12);
    expect(mesh.nodes.coordinates[3]).toBeCloseTo(0.001);
    expect(mesh.elements).toEqual([{ type: "Tet4", connectivity: [0, 1, 2, 3], material: "solid", physicalName: "solid" }]);
    expect(mesh.surfaceSets.map((set) => set.name).sort()).toEqual(["fixed_support", "hole_surfaces", "load_surface"]);
    expect(mesh.surfaceSets.find((set) => set.name === "fixed_support")?.facets.length).toBeGreaterThan(0);
    expect(mesh.surfaceFacets.find((facet) => facet.sourceSelectionRef === "FS1")?.sourceFaceId).toBe("face-base-left");
    expect(mesh.metadata).toMatchObject({
      source: "gmsh",
      nodeCount: 4,
      elementCount: 1,
      connectedComponentCount: 1
    });
  });

  test("builds a valid Core model from a cloud mesh and maps FS1/L1 through actual surface facets", () => {
    const volumeMesh = parseGmshMeshToCoreVolumeMesh(sampleMsh(), {
      units: "mm",
      sourceSelectionRefs: {
        fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
        load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" }
      }
    });
    const model = buildCoreModelFromCloudMesh({
      study: aluminumStudy,
      displayModel: undefined,
      volumeMesh,
      analysisType: "static_stress",
      solverSettings: {}
    });

    expect(validateModelJson(model).ok).toBe(true);
    expect(model.meshProvenance).toMatchObject({ meshSource: "actual_volume_mesh", solver: "opencae-core-cloud", resultSource: "computed" });
    expect(model.boundaryConditions[0]).toMatchObject({ type: "fixed", surfaceSet: "fixed_support" });
    expect(model.loads[0]).toMatchObject({ type: "surfaceForce", surfaceSet: "load_surface", totalForce: [0, -500, 0] });
  });

  test("maps selections by source ref, face id, physical name, and rejects low-confidence matches", () => {
    const volumeMesh = parseGmshMeshToCoreVolumeMesh(sampleMsh(), {
      units: "mm",
      sourceSelectionRefs: {
        fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
        load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" }
      }
    });

    expect(mapSelectionToSurfaceSet({ study: aluminumStudy, volumeMesh, selectionRef: "FS1", role: "fixed_support" }).name).toBe("fixed_support");
    expect(mapSelectionToSurfaceSet({ study: aluminumStudy, volumeMesh, selectionRef: "L1", role: "load_surface" }).name).toBe("load_surface");
    expect(mapSelectionToSurfaceSet({ study: aluminumStudy, volumeMesh, selectionRef: "face-base-left", role: "fixed_support" }).name).toBe("fixed_support");
    expect(() => mapSelectionToSurfaceSet({ study: aluminumStudy, volumeMesh, selectionRef: "missing", role: "fixed_support" })).toThrow(/could not map selection missing/i);
  });

  test("generates a structured block mesh only for the structured_block geometry path", () => {
    const mesh = generateStructuredBlockCoreVolumeMesh({
      kind: "structured_block",
      units: "mm",
      descriptor: { length: 20, width: 10, height: 8 }
    });

    expect(mesh.metadata.source).toBe("structured_block");
    expect(mesh.elements.length).toBeGreaterThan(0);
    expect(connectedComponents({ elementBlocks: [{ name: "solid", type: "Tet4", material: "mat", connectivity: mesh.elements.flatMap((element) => element.connectivity) }] }).componentCount).toBe(1);
    expect(mesh.surfaceSets.map((set) => set.name)).toEqual(expect.arrayContaining(["fixed_support", "load_surface"]));
  });

  test("bracket geometry source metadata pins procedural selection identity", () => {
    expect(bracketGeometrySourceMetadata()).toMatchObject({
      fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
      load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" }
    });
  });

  test("generates procedural bracket mesh with Gmsh when available", async () => {
    const availability = await assertGmshAvailable();
    if (!availability.available) return;

    const mesh = await generateBracketCoreVolumeMesh({
      kind: "sample_procedural",
      sampleId: "bracket",
      units: "mm",
      descriptor: {
        base: { length: 120, width: 34, height: 10 },
        upright: { height: 88, width: 18, thickness: 34 },
        gusset: { length: 72, height: 58, thickness: 34 },
        holes: [
          { id: "hole-base-1", center: [32, 17, 5], diameter: 12 },
          { id: "hole-base-2", center: [88, 17, 5], diameter: 12 },
          { id: "hole-upright-1", center: [9, 17, 56], diameter: 10 }
        ],
        meshSize: 24
      }
    });

    expect(mesh.metadata.connectedComponentCount).toBe(1);
    expect(mesh.elements.length).toBeGreaterThan(0);
    expect(mesh.surfaceSets.find((set) => set.name === "fixed_support")?.facets.length).toBeGreaterThan(0);
    expect(mesh.surfaceSets.find((set) => set.name === "load_surface")?.facets.length).toBeGreaterThan(0);
    expect(mesh.surfaceSets.find((set) => set.name === "hole_surfaces")?.facets.length).toBeGreaterThan(0);
  });

  test("keeps geometryDescriptor as a compatibility alias", () => {
    const mesh = generateStructuredBlockCoreVolumeMesh({
      kind: "structured_block",
      units: "mm",
      geometryDescriptor: { length: 30, width: 12, height: 6 }
    });

    expect(mesh.metadata.source).toBe("structured_block");
    expect(mesh.metadata.nodeCount).toBe(8);
    expect(mesh.nodes.coordinates[3]).toBeCloseTo(0.03);
  });
});

function sampleMsh(): string {
  return readFileSync(resolve(__dirname, "fixtures/sample-physical-tet.msh"), "utf8");
}
