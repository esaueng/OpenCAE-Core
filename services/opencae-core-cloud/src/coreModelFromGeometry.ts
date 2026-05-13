import type { OpenCAEModelJson, ValidationIssue } from "@opencae/core";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { structuredBlockCoreModelFromRequest } from "./geometry/structuredBlock";
import { generateCoreVolumeMeshFromGeometry } from "./mesh/generateCoreVolumeMesh";
import { CoreCloudMeshingError } from "./mesh/gmsh";
import type { CloudSolveRequest, CoreCloudSolveRequest } from "./types";

export type CoreModelFromGeometryResult =
  | { ok: true; model: OpenCAEModelJson; diagnostics: unknown[]; artifacts?: Record<string, unknown> }
  | { ok: false; issue: ValidationIssue; diagnostics?: unknown[]; status?: number };

export async function coreModelFromGeometry(request: CoreCloudSolveRequest): Promise<CoreModelFromGeometryResult> {
  const geometry = request.geometry;
  if (!geometry) {
    return failure("geometry-required", "OpenCAE Core Cloud requires geometry for geometry-to-Core model generation.", "$.geometry", {
      phase: "request_parse"
    });
  }

  try {
    if (geometry.kind === "structured_block") {
      const generated = structuredBlockCoreModelFromRequest(request);
      return { ok: true, ...generated };
    }
    if (geometry.kind === "sample_procedural" && (geometry.sampleId === "cantilever" || geometry.sampleId === "beam")) {
      const generated = structuredBlockCoreModelFromRequest(request);
      return { ok: true, ...generated };
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
        ok: true,
        model,
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
        ok: true,
        model,
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
      };
    }

    return failure(
      "unsupported-geometry",
      `Unsupported Core Cloud geometry source ${geometry.kind}${geometry.sampleId ? `/${geometry.sampleId}` : ""}`,
      "$.geometry",
      { phase: "request_parse" }
    );
  } catch (error) {
    if (error instanceof CoreCloudMeshingError) {
      const diagnostic = firstDiagnostic(error.diagnostics) ?? {
        code: error.code,
        phase: "geometry_to_mesh",
        message: error.message,
        path: "$.geometry"
      };
      return failure(
        typeof diagnostic.code === "string" ? diagnostic.code : error.code,
        typeof diagnostic.message === "string" ? diagnostic.message : error.message,
        typeof diagnostic.path === "string" ? diagnostic.path : "$.geometry",
        {
          phase: typeof diagnostic.phase === "string" ? diagnostic.phase : "geometry_to_mesh",
          diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [diagnostic],
          status: error.status
        }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure("core-model-build-failed", message, "$.geometry", { phase: "core_model_build" });
  }
}

function failure(
  code: string,
  message: string,
  path: string,
  options: { phase: string; diagnostics?: unknown[]; status?: number }
): CoreModelFromGeometryResult {
  return {
    ok: false,
    issue: { code, message, path },
    diagnostics: options.diagnostics ?? [{ code, phase: options.phase, message, path }],
    status: options.status ?? 422
  };
}

function firstDiagnostic(diagnostics: unknown[]): { code?: unknown; phase?: unknown; message?: unknown; path?: unknown } | undefined {
  return diagnostics.find((value): value is { code?: unknown; phase?: unknown; message?: unknown; path?: unknown } =>
    Boolean(value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string")
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
