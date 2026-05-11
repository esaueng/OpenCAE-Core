import type {
  ElementType,
  IsotropicLinearElasticMaterialJson,
  OpenCAEModelJson,
  SurfaceFacetJson,
  SurfaceSetJson
} from "@opencae/core";
import type { CpuSolverOptions, DynamicTet4CpuOptions } from "@opencae/solver-cpu";

export type CloudAnalysisType = "static_stress" | "dynamic_structural";

export type CloudGeometrySource = {
  kind: "sample_procedural" | "uploaded_cad" | "uploaded_mesh" | "structured_block";
  sampleId?: "cantilever" | "beam" | "bracket";
  format?: "step" | "stl" | "obj" | "msh" | "json";
  filename?: string;
  contentBase64?: string;
  units?: "mm" | "m";
  geometryDescriptor?: Record<string, unknown>;
};

export type SourceSelectionMetadata = {
  sourceSelectionRef?: string;
  sourceFaceId?: string;
};

export type CloudVolumeElement = {
  type: ElementType;
  connectivity: number[];
  material?: string;
  physicalName?: string;
};

export type CoreVolumeMeshArtifact = {
  nodes: {
    coordinates: number[];
  };
  elements: CloudVolumeElement[];
  surfaceFacets: SurfaceFacetJson[];
  surfaceSets: SurfaceSetJson[];
  coordinateSystem: {
    solverUnits: "m-N-s-Pa" | "mm-N-s-MPa";
    renderCoordinateSpace: "solver";
  };
  metadata: {
    source: "gmsh" | "structured_block" | "uploaded_mesh";
    nodeCount: number;
    elementCount: number;
    surfaceFacetCount: number;
    physicalGroups: Array<{
      dimension: 2 | 3;
      tag: number;
      name: string;
      entityCount: number;
    }>;
    connectedComponentCount: number;
    meshQuality: {
      minTetVolume: number;
      maxTetVolume: number;
      invertedElementCount: number;
    };
    diagnostics: string[];
    units: "m";
  };
};

export type CloudStudyLike = {
  id?: string;
  type?: CloudAnalysisType;
  materialAssignments?: Array<{
    materialId?: string;
    parameters?: Record<string, unknown>;
  }>;
  namedSelections?: Array<{
    id?: string;
    name?: string;
    entityType?: string;
    geometryRefs?: Array<{
      entityType?: string;
      entityId?: string;
      label?: string;
    }>;
  }>;
  constraints?: Array<{
    id?: string;
    type?: string;
    selectionRef?: string;
    parameters?: Record<string, unknown>;
  }>;
  loads?: Array<{
    id?: string;
    type?: string;
    selectionRef?: string;
    parameters?: Record<string, unknown>;
  }>;
  solverSettings?: Record<string, unknown>;
};

export type CloudSolveRequest = {
  runId?: string;
  analysisType: CloudAnalysisType;
  study?: CloudStudyLike;
  displayModel?: unknown;
  geometry?: CloudGeometrySource;
  material?: IsotropicLinearElasticMaterialJson | Record<string, unknown>;
  materials?: Array<IsotropicLinearElasticMaterialJson | Record<string, unknown>>;
  coreModel?: OpenCAEModelJson;
  coreVolumeMesh?: unknown;
  solverSettings?: (CpuSolverOptions & DynamicTet4CpuOptions & { allowPreview?: boolean }) | undefined;
  resultSettings?: Record<string, unknown>;
};
