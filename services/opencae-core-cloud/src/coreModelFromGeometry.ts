import type { OpenCAEModelJson } from "@opencae/core";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { structuredBlockCoreModelFromRequest } from "./geometry/structuredBlock";
import { generateCoreVolumeMeshFromGeometry } from "./mesh/generateCoreVolumeMesh";
import { CoreCloudMeshingError } from "./mesh/gmsh";
import type { CloudSolveRequest, CoreCloudSolveRequest } from "./types";

export async function coreModelFromGeometry(request: CoreCloudSolveRequest): Promise<{
  model: OpenCAEModelJson;
  diagnostics: unknown;
}> {
  const geometry = request.geometry;
  if (!geometry) {
    throw new CoreCloudMeshingError("geometry-required", "OpenCAE Core Cloud requires geometry for geometry-to-Core model generation.", {
      diagnostics: [
        {
          code: "geometry-required",
          phase: "request_parse",
          message: "OpenCAE Core Cloud requires geometry for geometry-to-Core model generation.",
          path: "$.geometry"
        }
      ]
    });
  }

  if (geometry.kind === "structured_block") {
    return structuredBlockCoreModelFromRequest(request);
  }
  if (geometry.kind === "sample_procedural" && (geometry.sampleId === "cantilever" || geometry.sampleId === "beam")) {
    return structuredBlockCoreModelFromRequest(request);
  }

  if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") {
    const volumeMesh = await generateCoreVolumeMeshFromGeometry(geometry, request as CloudSolveRequest);
    const model = buildCoreModelFromCloudMesh({
      study: request.study as CloudSolveRequest["study"],
      displayModel: request.displayModel,
      volumeMesh,
      material: request.material,
      materials: request.materials,
      analysisType: request.analysisType ?? "static_stress",
      solverSettings: request.solverSettings
    });
    return {
      model,
      diagnostics: {
        artifacts: {
          generatedCoreModel: model,
          meshSummary: meshSummaryArtifact(volumeMesh, [
            {
              code: "bracket-model-generated",
              phase: "geometry_to_core_model",
              message: "Procedural bracket Core model generated.",
              details: {
                nodeCount: volumeMesh.metadata.nodeCount,
                elementCount: volumeMesh.metadata.elementCount,
                surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount
              }
            }
          ])
        },
        diagnostics: [
          meshGenerationDiagnostic(volumeMesh),
          {
            code: "bracket-model-generated",
            phase: "geometry_to_core_model",
            message: "Procedural bracket Core model generated.",
            details: {
              nodeCount: volumeMesh.metadata.nodeCount,
              elementCount: volumeMesh.metadata.elementCount,
              surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount
            }
          }
        ]
      }
    };
  }

  if (geometry.kind === "uploaded_cad" || geometry.kind === "uploaded_mesh") {
    const volumeMesh = await generateCoreVolumeMeshFromGeometry(geometry, request as CloudSolveRequest);
    const model = buildCoreModelFromCloudMesh({
      study: request.study as CloudSolveRequest["study"],
      displayModel: request.displayModel,
      volumeMesh,
      material: request.material,
      materials: request.materials,
      analysisType: request.analysisType ?? "static_stress",
      solverSettings: request.solverSettings
    });
    return {
      model,
      diagnostics: {
        artifacts: {
          generatedCoreModel: model,
          meshSummary: meshSummaryArtifact(volumeMesh, [
            {
              code: "uploaded-geometry-model-generated",
              phase: "geometry_to_core_model",
              message: "Uploaded geometry Core model generated.",
              details: {
                nodeCount: volumeMesh.metadata.nodeCount,
                elementCount: volumeMesh.metadata.elementCount,
                surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount
              }
            }
          ])
        },
        diagnostics: [
          meshGenerationDiagnostic(volumeMesh),
          {
            code: "uploaded-geometry-model-generated",
            phase: "geometry_to_core_model",
            message: "Uploaded geometry Core model generated.",
            details: {
              nodeCount: volumeMesh.metadata.nodeCount,
              elementCount: volumeMesh.metadata.elementCount,
              surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount
            }
          }
        ]
      }
    };
  }

  throw new CoreCloudMeshingError(
    "unsupported-geometry",
    `Unsupported Core Cloud geometry source ${geometry.kind}${geometry.sampleId ? `/${geometry.sampleId}` : ""}`,
    {
      diagnostics: [
        {
          code: "unsupported-geometry",
          phase: "request_parse",
          message: `Unsupported Core Cloud geometry source ${geometry.kind}${geometry.sampleId ? `/${geometry.sampleId}` : ""}`,
          path: "$.geometry"
        }
      ]
    }
  );
}

function meshGenerationDiagnostic(volumeMesh: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return {
    id: "core-cloud-mesh-generation",
    source: volumeMesh.metadata.source,
    mesher: volumeMesh.metadata.source === "structured_block" ? "structured_block" : "gmsh",
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics
  };
}

function meshSummaryArtifact(volumeMesh: { metadata: Record<string, unknown> }, phaseDiagnostics: unknown[]): Record<string, unknown> {
  return {
    source: volumeMesh.metadata.source,
    nodeCount: volumeMesh.metadata.nodeCount,
    elementCount: volumeMesh.metadata.elementCount,
    surfaceFacetCount: volumeMesh.metadata.surfaceFacetCount,
    connectedComponentCount: volumeMesh.metadata.connectedComponentCount,
    physicalGroups: volumeMesh.metadata.physicalGroups,
    meshQuality: volumeMesh.metadata.meshQuality,
    diagnostics: volumeMesh.metadata.diagnostics,
    phaseDiagnostics: [...phaseDiagnostics]
  };
}
