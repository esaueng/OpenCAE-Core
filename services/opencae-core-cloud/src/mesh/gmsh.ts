import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ElementType, SurfaceFacetJson, SurfaceSetJson } from "@opencae/core";
import type { CloudGeometrySource, CoreVolumeMeshArtifact, SourceSelectionMetadata } from "../types";

type GmshPhysicalName = {
  dimension: 2 | 3;
  tag: number;
  name: string;
};

type ParsedElement = {
  id: number;
  typeCode: number;
  physicalTag?: number;
  geometricTag?: number;
  nodes: number[];
};

type ParseOptions = {
  units?: "mm" | "m";
  sourceSelectionRefs?: Record<string, SourceSelectionMetadata>;
  diagnostics?: string[];
  source?: CoreVolumeMeshArtifact["metadata"]["source"];
};

type RunCommandResult = {
  stdout: string;
  stderr: string;
};

export class CoreCloudMeshingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnostics: string[];

  constructor(code: string, message: string, options: { status?: number; diagnostics?: string[] } = {}) {
    super(`${message.replace(/\.+$/, "")}. No local estimate fallback was used.`);
    this.name = "CoreCloudMeshingError";
    this.code = code;
    this.status = options.status ?? 422;
    this.diagnostics = options.diagnostics ?? [];
  }
}

export async function assertGmshAvailable(): Promise<{ available: boolean; version?: string; message?: string }> {
  try {
    const result = await execFileText("gmsh", ["--version"], 5000);
    const version = result.stdout.trim().split(/\s+/)[0] || result.stderr.trim().split(/\s+/)[0] || "unknown";
    return { available: true, version };
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateGmshVolumeMeshFromGeo(
  geoScript: string,
  options: ParseOptions = {}
): Promise<CoreVolumeMeshArtifact> {
  const availability = await assertGmshAvailable();
  if (!availability.available) {
    throw new CoreCloudMeshingError("gmsh-unavailable", `Gmsh is unavailable for Core Cloud meshing: ${availability.message ?? "gmsh --version failed"}`, {
      status: 503,
      diagnostics: [availability.message ?? "gmsh unavailable"]
    });
  }

  const workdir = await mkdtemp(join(tmpdir(), "opencae-core-cloud-"));
  const geoPath = join(workdir, "geometry.geo");
  const meshPath = join(workdir, "mesh.msh");
  try {
    await writeFile(geoPath, geoScript, "utf8");
    const result = await execFileText("gmsh", [geoPath, "-3", "-format", "msh2", "-o", meshPath], 120000);
    const mesh = await readFile(meshPath, "utf8");
    return parseGmshMeshToCoreVolumeMesh(mesh, {
      ...options,
      diagnostics: [
        `gmsh ${availability.version ?? "unknown"}`,
        ...compactLines(result.stdout),
        ...compactLines(result.stderr),
        ...(options.diagnostics ?? [])
      ]
    });
  } catch (error) {
    if (error instanceof CoreCloudMeshingError) throw error;
    const diagnostics = errorDiagnostics(error);
    throw new CoreCloudMeshingError("gmsh-meshing-failed", `Gmsh volume meshing failed: ${diagnostics[0] ?? "unknown error"}`, {
      diagnostics
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function generateGmshVolumeMeshFromUpload(
  geometry: CloudGeometrySource,
  options: ParseOptions = {}
): Promise<CoreVolumeMeshArtifact> {
  if (!geometry.contentBase64) {
    throw new CoreCloudMeshingError("missing-upload-content", "Uploaded CAD meshing requires contentBase64");
  }
  const availability = await assertGmshAvailable();
  if (!availability.available) {
    throw new CoreCloudMeshingError("gmsh-unavailable", `Gmsh is unavailable for Core Cloud meshing: ${availability.message ?? "gmsh --version failed"}`, {
      status: 503,
      diagnostics: [availability.message ?? "gmsh unavailable"]
    });
  }
  const workdir = await mkdtemp(join(tmpdir(), "opencae-core-cloud-upload-"));
  const extension = uploadExtension(geometry);
  const inputPath = join(workdir, `upload${extension}`);
  const meshPath = join(workdir, `${basename(inputPath, extension)}.msh`);
  try {
    await writeFile(inputPath, base64ToBytes(geometry.contentBase64));
    const result = await execFileText("gmsh", [inputPath, "-3", "-format", "msh2", "-o", meshPath], 120000);
    const mesh = await readFile(meshPath, "utf8");
    return parseGmshMeshToCoreVolumeMesh(mesh, {
      ...options,
      diagnostics: [`uploaded ${geometry.filename ?? "geometry"} meshed with gmsh ${availability.version ?? "unknown"}`, ...compactLines(result.stderr)]
    });
  } catch (error) {
    if (error instanceof CoreCloudMeshingError) throw error;
    const diagnostics = errorDiagnostics(error);
    throw new CoreCloudMeshingError("gmsh-meshing-failed", `Gmsh uploaded geometry meshing failed: ${diagnostics[0] ?? "unknown error"}`, {
      diagnostics
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export function parseUploadedMeshGeometry(
  geometry: CloudGeometrySource,
  options: ParseOptions = {}
): CoreVolumeMeshArtifact {
  if (!geometry.contentBase64) {
    throw new CoreCloudMeshingError("missing-upload-content", "Uploaded mesh parsing requires contentBase64");
  }
  const text = bytesToText(base64ToBytes(geometry.contentBase64));
  if (geometry.format === "msh" || geometry.filename?.toLowerCase().endsWith(".msh")) {
    return parseGmshMeshToCoreVolumeMesh(text, { ...options, source: "uploaded_mesh" });
  }
  if (geometry.format === "json" || geometry.filename?.toLowerCase().endsWith(".json")) {
    return parseCoreVolumeMeshJson(text);
  }
  throw new CoreCloudMeshingError("unsupported-uploaded-mesh", `Uploaded mesh format ${geometry.format ?? "unknown"} is not supported`);
}

export function parseGmshMeshToCoreVolumeMesh(meshFile: string, options: ParseOptions = {}): CoreVolumeMeshArtifact {
  const sections = gmshSections(meshFile);
  const physicalNames = parsePhysicalNames(sections.get("PhysicalNames") ?? []);
  const nodes = parseNodes(sections.get("Nodes") ?? [], options.units ?? "m");
  const elements = parseElements(sections.get("Elements") ?? []);
  const physicalByKey = new Map(physicalNames.map((name) => [`${name.dimension}:${name.tag}`, name.name]));
  const volumeElements = elements.filter((element) => elementType(element.typeCode) !== undefined);
  if (volumeElements.length === 0) {
    throw new CoreCloudMeshingError("empty-volume-mesh", "Gmsh mesh did not contain Tet4 or Tet10 volume elements");
  }

  const usedNodeIds = new Set<number>();
  for (const element of elements) {
    const type = elementType(element.typeCode) ?? surfaceElementType(element.typeCode);
    if (!type) continue;
    for (const node of element.nodes) usedNodeIds.add(node);
  }
  const nodeMap = contiguousNodeMap([...usedNodeIds].sort((a, b) => a - b));
  const coordinates: number[] = [];
  for (const gmshNodeId of [...usedNodeIds].sort((a, b) => a - b)) {
    const coordinate = nodes.get(gmshNodeId);
    if (!coordinate) throw new CoreCloudMeshingError("missing-node", `Gmsh element referenced missing node ${gmshNodeId}`);
    coordinates.push(...coordinate);
  }

  const ownerFaces = new Map<string, { element: number; elementFace: number; nodes: number[] }>();
  const coreElements = volumeElements.map((element, elementIndex) => {
    const type = elementType(element.typeCode)!;
    const connectivity = element.nodes.map((node) => mappedNode(nodeMap, node));
    for (const face of elementFaces(type, connectivity)) {
      ownerFaces.set(faceKey(face.nodes), {
        element: elementIndex,
        elementFace: face.elementFace,
        nodes: face.nodes
      });
    }
    const physicalName = physicalNameFor(physicalByKey, 3, element.physicalTag) ?? "solid";
    return {
      type,
      connectivity,
      material: physicalName,
      physicalName
    };
  });

  const surfaceFacets: SurfaceFacetJson[] = [];
  const surfaceFacetsByPhysicalName = new Map<string, number[]>();
  const surfaceElements = elements.filter((element) => surfaceElementType(element.typeCode) !== undefined);
  for (const surfaceElement of surfaceElements) {
    const surfaceNodes = surfaceElement.nodes.map((node) => mappedNode(nodeMap, node));
    const owner = ownerFaces.get(faceKey(surfaceNodes));
    if (!owner) continue;
    const physicalName = physicalNameFor(physicalByKey, 2, surfaceElement.physicalTag) ?? `surface_${surfaceElement.physicalTag ?? surfaceElement.geometricTag ?? surfaceElement.id}`;
    const source = options.sourceSelectionRefs?.[physicalName] ?? {};
    const geometry = triangleGeometry(coordinates, surfaceNodes);
    const facet: SurfaceFacetJson = {
      id: surfaceFacets.length,
      element: owner.element,
      elementFace: owner.elementFace,
      nodes: surfaceNodes,
      area: geometry.area,
      normal: geometry.normal,
      center: geometry.center,
      sourceFaceId: source.sourceFaceId,
      sourceSelectionRef: source.sourceSelectionRef
    };
    surfaceFacets.push(facet);
    const group = surfaceFacetsByPhysicalName.get(physicalName);
    if (group) group.push(facet.id);
    else surfaceFacetsByPhysicalName.set(physicalName, [facet.id]);
  }

  const surfaceSets: SurfaceSetJson[] = [...surfaceFacetsByPhysicalName.entries()].map(([name, facets]) => ({
    name,
    facets: [...new Set(facets)].sort((left, right) => left - right)
  }));
  const connectedComponentCount = connectedComponentCountForElements(coreElements);
  const quality = summarizeMeshQuality(coordinates, coreElements);

  return {
    nodes: { coordinates },
    elements: coreElements,
    surfaceFacets,
    surfaceSets,
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: options.source ?? "gmsh",
      nodeCount: coordinates.length / 3,
      elementCount: coreElements.length,
      surfaceFacetCount: surfaceFacets.length,
      physicalGroups: physicalNames.map((name) => ({
        dimension: name.dimension,
        tag: name.tag,
        name: name.name,
        entityCount: name.dimension === 2
          ? surfaceFacetsByPhysicalName.get(name.name)?.length ?? 0
          : coreElements.filter((element) => element.physicalName === name.name).length
      })),
      connectedComponentCount,
      meshQuality: quality,
      diagnostics: options.diagnostics ?? [],
      units: "m"
    }
  };
}

function gmshSections(meshFile: string): Map<string, string[]> {
  const lines = meshFile.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const sectionStart = line.match(/^\$([A-Za-z]+)$/);
    if (sectionStart && !line.startsWith("$End")) {
      current = sectionStart[1];
      sections.set(current, []);
      continue;
    }
    if (line.startsWith("$End")) {
      current = undefined;
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  return sections;
}

function parsePhysicalNames(lines: string[]): GmshPhysicalName[] {
  const count = Number.parseInt(lines[0] ?? "0", 10);
  const names: GmshPhysicalName[] = [];
  for (const line of lines.slice(1, count + 1)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+"(.+)"$/);
    if (!match) continue;
    const dimension = Number.parseInt(match[1]!, 10);
    if (dimension !== 2 && dimension !== 3) continue;
    names.push({
      dimension,
      tag: Number.parseInt(match[2]!, 10),
      name: match[3]!
    });
  }
  return names;
}

function parseNodes(lines: string[], units: "mm" | "m"): Map<number, [number, number, number]> {
  const scale = units === "mm" ? 0.001 : 1;
  const count = Number.parseInt(lines[0] ?? "0", 10);
  const nodes = new Map<number, [number, number, number]>();
  for (const line of lines.slice(1, count + 1)) {
    const parts = line.split(/\s+/);
    const id = Number.parseInt(parts[0] ?? "", 10);
    const x = Number(parts[1]) * scale;
    const y = Number(parts[2]) * scale;
    const z = Number(parts[3]) * scale;
    if (!Number.isInteger(id) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new CoreCloudMeshingError("invalid-node", `Invalid Gmsh node line: ${line}`);
    }
    nodes.set(id, [x, y, z]);
  }
  return nodes;
}

function parseElements(lines: string[]): ParsedElement[] {
  const count = Number.parseInt(lines[0] ?? "0", 10);
  const elements: ParsedElement[] = [];
  for (const line of lines.slice(1, count + 1)) {
    const parts = line.split(/\s+/).map((part) => Number.parseInt(part, 10));
    const id = parts[0];
    const typeCode = parts[1];
    const tagCount = parts[2] ?? 0;
    if (!Number.isInteger(id) || !Number.isInteger(typeCode) || !Number.isInteger(tagCount)) {
      throw new CoreCloudMeshingError("invalid-element", `Invalid Gmsh element line: ${line}`);
    }
    const tags = parts.slice(3, 3 + tagCount);
    const nodes = parts.slice(3 + tagCount);
    elements.push({
      id,
      typeCode,
      physicalTag: tags[0],
      geometricTag: tags[1],
      nodes
    });
  }
  return elements;
}

function elementType(typeCode: number): ElementType | undefined {
  if (typeCode === 4) return "Tet4";
  if (typeCode === 11) return "Tet10";
  return undefined;
}

function surfaceElementType(typeCode: number): "Tri3" | "Tri6" | undefined {
  if (typeCode === 2) return "Tri3";
  if (typeCode === 9) return "Tri6";
  return undefined;
}

function contiguousNodeMap(nodeIds: number[]): Map<number, number> {
  return new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
}

function mappedNode(nodeMap: Map<number, number>, node: number): number {
  const mapped = nodeMap.get(node);
  if (mapped === undefined) throw new CoreCloudMeshingError("missing-node", `Gmsh node ${node} was not found in the contiguous node map`);
  return mapped;
}

function physicalNameFor(physicalByKey: Map<string, string>, dimension: 2 | 3, tag: number | undefined): string | undefined {
  return tag === undefined ? undefined : physicalByKey.get(`${dimension}:${tag}`);
}

function elementFaces(type: ElementType, connectivity: number[]): Array<{ elementFace: number; nodes: number[] }> {
  const faces = type === "Tet10"
    ? [
        [1, 2, 3, 5, 9, 8],
        [0, 3, 2, 7, 9, 6],
        [0, 1, 3, 4, 8, 7],
        [0, 2, 1, 6, 5, 4]
      ]
    : [
        [1, 2, 3],
        [0, 3, 2],
        [0, 1, 3],
        [0, 2, 1]
      ];
  return faces.map((face, elementFace) => ({
    elementFace,
    nodes: face.map((localNode) => connectivity[localNode]!)
  }));
}

function faceKey(nodes: number[]): string {
  return [...nodes.slice(0, 3)].sort((left, right) => left - right).join(":");
}

function triangleGeometry(coordinates: number[], nodes: number[]): { area: number; normal: [number, number, number]; center: [number, number, number] } {
  const a = coordinateAt(coordinates, nodes[0]!);
  const b = coordinateAt(coordinates, nodes[1]!);
  const c = coordinateAt(coordinates, nodes[2]!);
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross: [number, number, number] = [
    ab[1]! * ac[2]! - ab[2]! * ac[1]!,
    ab[2]! * ac[0]! - ab[0]! * ac[2]!,
    ab[0]! * ac[1]! - ab[1]! * ac[0]!
  ];
  const length = Math.hypot(...cross);
  return {
    area: length / 2,
    normal: length > 0 ? [cross[0] / length, cross[1] / length, cross[2] / length] : [0, 0, 0],
    center: [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3
    ]
  };
}

function coordinateAt(coordinates: number[], node: number): [number, number, number] {
  return [coordinates[node * 3] ?? 0, coordinates[node * 3 + 1] ?? 0, coordinates[node * 3 + 2] ?? 0];
}

function connectedComponentCountForElements(elements: Array<{ connectivity: number[] }>): number {
  const componentByElement = new Int32Array(elements.length);
  componentByElement.fill(-1);
  const elementsByNode = new Map<number, number[]>();
  elements.forEach((element, index) => {
    for (const node of element.connectivity) {
      const list = elementsByNode.get(node);
      if (list) list.push(index);
      else elementsByNode.set(node, [index]);
    }
  });
  let componentCount = 0;
  for (let start = 0; start < elements.length; start += 1) {
    if (componentByElement[start] !== -1) continue;
    const stack = [start];
    componentByElement[start] = componentCount;
    while (stack.length > 0) {
      const element = stack.pop()!;
      for (const node of elements[element]!.connectivity) {
        for (const neighbor of elementsByNode.get(node) ?? []) {
          if (componentByElement[neighbor] === -1) {
            componentByElement[neighbor] = componentCount;
            stack.push(neighbor);
          }
        }
      }
    }
    componentCount += 1;
  }
  return componentCount;
}

function summarizeMeshQuality(coordinates: number[], elements: Array<{ type: ElementType; connectivity: number[] }>): CoreVolumeMeshArtifact["metadata"]["meshQuality"] {
  const volumes = elements
    .filter((element) => element.type === "Tet4")
    .map((element) => tet4Volume(coordinates, element.connectivity));
  return {
    minTetVolume: volumes.length ? Math.min(...volumes) : 0,
    maxTetVolume: volumes.length ? Math.max(...volumes) : 0,
    invertedElementCount: volumes.filter((volume) => !Number.isFinite(volume) || volume <= 0).length
  };
}

function tet4Volume(coordinates: number[], nodes: number[]): number {
  const a = coordinateAt(coordinates, nodes[0]!);
  const b = coordinateAt(coordinates, nodes[1]!);
  const c = coordinateAt(coordinates, nodes[2]!);
  const d = coordinateAt(coordinates, nodes[3]!);
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const cax = c[0] - a[0];
  const cay = c[1] - a[1];
  const caz = c[2] - a[2];
  const dax = d[0] - a[0];
  const day = d[1] - a[1];
  const daz = d[2] - a[2];
  return (bax * (cay * daz - caz * day) - bay * (cax * daz - caz * dax) + baz * (cax * day - cay * dax)) / 6;
}

function execFileText(command: string, args: string[], timeout: number): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      const result = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
      if (error) {
        reject(Object.assign(error, result));
        return;
      }
      resolve(result);
    });
  });
}

function compactLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-20);
}

function errorDiagnostics(error: unknown): string[] {
  if (!error || typeof error !== "object") return [String(error)];
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [
    typeof candidate.message === "string" ? candidate.message : undefined,
    ...(typeof candidate.stdout === "string" ? compactLines(candidate.stdout) : []),
    ...(typeof candidate.stderr === "string" ? compactLines(candidate.stderr) : [])
  ].filter((line): line is string => Boolean(line));
}

function uploadExtension(geometry: CloudGeometrySource): string {
  const fromFilename = geometry.filename ? extname(geometry.filename) : "";
  if (fromFilename) return fromFilename;
  return geometry.format ? `.${geometry.format}` : ".step";
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function bytesToText(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function parseCoreVolumeMeshJson(text: string): CoreVolumeMeshArtifact {
  const parsed = JSON.parse(text) as CoreVolumeMeshArtifact;
  if (!parsed.nodes?.coordinates || !Array.isArray(parsed.elements)) {
    throw new CoreCloudMeshingError("invalid-uploaded-mesh", "Uploaded mesh JSON is not a CoreVolumeMeshArtifact");
  }
  return parsed;
}
