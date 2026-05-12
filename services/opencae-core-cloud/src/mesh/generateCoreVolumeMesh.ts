import { generateBracketCoreVolumeMesh } from "../geometry/bracket";
import { generateStructuredBlockCoreVolumeMesh } from "../geometry/structuredBlock";
import type { CoreCloudGeometryPayload, CoreCloudResourceSettings, CoreCloudSolveRequest, CoreVolumeMeshArtifact } from "../types";
import {
  CoreCloudMeshingError,
  generateGmshVolumeMeshFromUpload,
  parseUploadedMeshGeometry
} from "./gmsh";

export async function generateCoreVolumeMeshFromGeometry(
  geometry: CoreCloudGeometryPayload,
  request: Pick<CoreCloudSolveRequest, "analysisType" | "study" | "displayModel" | "solverSettings">
): Promise<CoreVolumeMeshArtifact> {
  const options: CoreCloudResourceSettings = {
    maxUploadBytes: request.solverSettings?.maxUploadBytes
  };
  if (geometry.kind === "structured_block") return generateStructuredBlockCoreVolumeMesh(geometry);
  if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") return generateBracketCoreVolumeMesh(geometry);
  if (geometry.kind === "uploaded_cad") return generateGmshVolumeMeshFromUpload(geometry, { units: geometry.units ?? "m", ...options });
  if (geometry.kind === "uploaded_mesh") return parseUploadedMeshGeometry(geometry, { units: geometry.units ?? "m", ...options });
  throw new CoreCloudMeshingError("unsupported-geometry", `Unsupported Core Cloud geometry source ${geometry.kind}${geometry.sampleId ? `/${geometry.sampleId}` : ""}`);
}
