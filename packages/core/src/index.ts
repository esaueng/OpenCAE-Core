export const OPENCAE_CORE_VERSION = "0.1.0";
export type {
  BoundaryConditionJson,
  BodyGravityLoadJson,
  CoordinateSystemJson,
  DisplacementComponent,
  DynamicLinearStepJson,
  DynamicLoadProfileJson,
  DynamicStepJson,
  ElementSetJson,
  ElementBlockJson,
  ElementType,
  FixedBoundaryConditionJson,
  IsotropicLinearElasticMaterialJson,
  LoadJson,
  MeshConnectionJson,
  MeshProvenanceJson,
  ModelNormalizationResult,
  NodalForceLoadJson,
  NodeSetJson,
  NormalizedElementBlock,
  NormalizedElementSet,
  NormalizedNodeSet,
  NormalizedOpenCAEModel,
  NormalizedSurfaceFacet,
  NormalizedSurfaceSet,
  NormalizedTet4ElementBlock,
  OpenCAEModelJson,
  PressureLoadJson,
  PrescribedDisplacementBoundaryConditionJson,
  ResultFieldJson,
  ResultSampleLocation,
  SolverSurfaceMeshJson,
  StaticLinearStepJson,
  StepJson,
  SurfaceFacetJson,
  SurfaceForceLoadJson,
  SurfaceSetJson,
  Tet10ElementBlockJson,
  Tet4ElementBlockJson,
  ValidationIssue,
  ValidationReport
} from "./model-json";
export {
  OPENCAE_LEGACY_MODEL_SCHEMA_VERSION,
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION
} from "./model-json";
export type {
  BuildSurfaceFacetsInput,
  ConnectedComponentsResult,
  MeshLike,
  SelectionMappingOptions,
  SolverSurfaceMeshInput
} from "./topology";
export {
  buildSurfaceFacets,
  COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH,
  computeTet4SignedVolume,
  connectedComponents,
  createSolverSurfaceMesh,
  deriveNodeSetFromSurfaceSet,
  mapSelectionToSurfaceSet,
  nodesPerElement
} from "./topology";
export type { DisplayModelLike, VolumeMeshSurfaceSetInput, VolumeMeshToModelInput } from "./mesh-adapter";
export {
  assertCoreCanUseDisplayModel,
  deriveFixedSupportNodeSetFromSurface,
  isSimpleBlockLikeDisplayModel,
  volumeMeshToModelJson
} from "./mesh-adapter";
export type { ElementFace, MeshConnectedComponents, MeshQualitySummary, MeshUtilityModel } from "./mesh";
export * as mesh from "./mesh";
export {
  elementFaces,
  elementNodeCount,
  extractBoundarySurfaceFacets,
  meshQualitySummary,
  nodeSetFromSurfaceSet,
  orphanNodes,
  surfaceArea,
  surfaceNormalAverage,
  tet4Volume
} from "./mesh";
export { normalizeModelJson } from "./normalize";
export { validateModelJson } from "./validation";
