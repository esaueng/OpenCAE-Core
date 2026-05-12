import { generateGmshVolumeMeshFromGeo } from "../mesh/gmsh";
import type { CloudGeometrySource, CoreVolumeMeshArtifact, SourceSelectionMetadata } from "../types";

export type BracketGeometryDescriptor = {
  base?: {
    length?: number;
    width?: number;
    height?: number;
  };
  upright?: {
    height?: number;
    width?: number;
    thickness?: number;
    depth?: number;
  };
  gusset?: {
    length?: number;
    height?: number;
    thickness?: number;
  };
  rib?: {
    length?: number;
    height?: number;
    thickness?: number;
  };
  holes?: Array<{
    center?: [number, number, number];
    diameter?: number;
  }>;
  baseLength?: number;
  baseDepth?: number;
  baseHeight?: number;
  uprightHeight?: number;
  uprightWidth?: number;
  uprightDepth?: number;
  gussetLength?: number;
  gussetHeight?: number;
  gussetThickness?: number;
  loadFaceId?: string;
  supportFaceId?: string;
  meshSize?: number;
  holeDiameters?: number[];
  holeCenters?: Array<[number, number, number]>;
};

export function bracketGeometrySourceMetadata(): Record<string, SourceSelectionMetadata> {
  return {
    fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
    load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" },
    hole_surfaces: { sourceFaceId: "bracket-hole-surfaces" },
    base_surfaces: { sourceFaceId: "bracket-base-surfaces" },
    upright_surfaces: { sourceFaceId: "bracket-upright-surfaces" },
    gusset_surfaces: { sourceFaceId: "bracket-gusset-surfaces" }
  };
}

export async function generateBracketCoreVolumeMesh(geometry: CloudGeometrySource): Promise<CoreVolumeMeshArtifact> {
  if (geometry.kind !== "sample_procedural" || geometry.sampleId !== "bracket") {
    throw new Error("Bracket procedural mesh generation requires sample_procedural bracket geometry.");
  }
  const descriptor = bracketDescriptor(geometry.descriptor ?? geometry.geometryDescriptor);
  return generateGmshVolumeMeshFromGeo(bracketGeoScript(descriptor), {
    units: "mm",
    sourceSelectionRefs: bracketGeometrySourceMetadata(),
    diagnostics: ["sample_procedural bracket geometry"]
  });
}

export function bracketGeoScript(descriptor: BracketGeometryDescriptor = {}): string {
  const baseLength = positive(descriptor.base?.length ?? descriptor.baseLength, 120);
  const baseDepth = positive(descriptor.base?.width ?? descriptor.upright?.thickness ?? descriptor.upright?.depth ?? descriptor.baseDepth ?? descriptor.uprightDepth, 34);
  const baseHeight = positive(descriptor.base?.height ?? descriptor.baseHeight, 10);
  const uprightHeight = positive(descriptor.upright?.height ?? descriptor.uprightHeight, 88);
  const uprightWidth = positive(descriptor.upright?.width ?? descriptor.uprightWidth, 18);
  const uprightDepth = positive(descriptor.upright?.thickness ?? descriptor.upright?.depth ?? descriptor.uprightDepth, baseDepth);
  const gussetLength = positive(descriptor.gusset?.length ?? descriptor.rib?.length ?? descriptor.gussetLength, 72);
  const gussetHeight = positive(descriptor.gusset?.height ?? descriptor.rib?.height ?? descriptor.gussetHeight, 58);
  const meshSize = positive(descriptor.meshSize, 18);

  return [
    'SetFactory("OpenCASCADE");',
    "Mesh.MshFileVersion = 2.2;",
    "Mesh.ElementOrder = 1;",
    `Mesh.CharacteristicLengthMin = ${fmt(meshSize * 0.45)};`,
    `Mesh.CharacteristicLengthMax = ${fmt(meshSize)};`,
    `Box(1) = {0, 0, 0, ${fmt(baseLength)}, ${fmt(baseDepth)}, ${fmt(baseHeight)}};`,
    `Box(2) = {0, 0, ${fmt(baseHeight)}, ${fmt(uprightWidth)}, ${fmt(uprightDepth)}, ${fmt(uprightHeight - baseHeight)}};`,
    `Point(101) = {${fmt(uprightWidth)}, 0, ${fmt(baseHeight)}, ${fmt(meshSize)}};`,
    `Point(102) = {${fmt(uprightWidth)}, 0, ${fmt(Math.min(uprightHeight, baseHeight + gussetHeight))}, ${fmt(meshSize)}};`,
    `Point(103) = {${fmt(Math.min(baseLength, uprightWidth + gussetLength))}, 0, ${fmt(baseHeight)}, ${fmt(meshSize)}};`,
    "Line(101) = {101, 102};",
    "Line(102) = {102, 103};",
    "Line(103) = {103, 101};",
    "Curve Loop(101) = {101, 102, 103};",
    "Plane Surface(101) = {101};",
    `rib[] = Extrude {0, ${fmt(baseDepth)}, 0} { Surface{101}; };`,
    "Coherence;",
    "eps = 0.01;",
    `fixed[] = Surface In BoundingBox{-eps, -eps, -eps, ${fmt(baseLength)} + eps, ${fmt(baseDepth)} + eps, eps};`,
    `load[] = Surface In BoundingBox{-eps, -eps, ${fmt(uprightHeight)} - eps, ${fmt(uprightWidth)} + eps, ${fmt(baseDepth)} + eps, ${fmt(uprightHeight)} + eps};`,
    `base[] = Surface In BoundingBox{-eps, -eps, -eps, ${fmt(baseLength)} + eps, ${fmt(baseDepth)} + eps, ${fmt(baseHeight)} + eps};`,
    `upright[] = Surface In BoundingBox{-eps, -eps, ${fmt(baseHeight)} - eps, ${fmt(uprightWidth)} + eps, ${fmt(baseDepth)} + eps, ${fmt(uprightHeight)} + eps};`,
    `gusset[] = Surface In BoundingBox{${fmt(uprightWidth)} - eps, -eps, ${fmt(baseHeight)} - eps, ${fmt(Math.min(baseLength, uprightWidth + gussetLength))} + eps, ${fmt(baseDepth)} + eps, ${fmt(Math.min(uprightHeight, baseHeight + gussetHeight))} + eps};`,
    "Physical Volume(\"solid\") = {1, 2, rib[1]};",
    "Physical Surface(\"fixed_support\") = {fixed[]};",
    "Physical Surface(\"load_surface\") = {load[]};",
    "Physical Surface(\"base_surfaces\") = {base[]};",
    "Physical Surface(\"upright_surfaces\") = {upright[]};",
    "Physical Surface(\"gusset_surfaces\") = {gusset[]};",
    ""
  ].join("\n");
}

function bracketDescriptor(value: unknown): BracketGeometryDescriptor {
  return value && typeof value === "object" ? value as BracketGeometryDescriptor : {};
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
