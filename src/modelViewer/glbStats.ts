// What a GLB costs and contains, read from its JSON chunk without rendering it.

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

type Mat4 = number[];

interface GltfAccessor {
  count: number;
  min?: number[];
  max?: number[];
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfImage {
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}

export interface Gltf {
  asset: { generator?: string; version: string };
  accessors?: GltfAccessor[];
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  meshes?: Array<{ primitives: GltfPrimitive[] }>;
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  materials?: unknown[];
  textures?: unknown[];
  images?: GltfImage[];
  extensionsUsed?: string[];
}

export interface GlbImage {
  mimeType: string;
  bytes: number;
  /** The encoded image, for measuring its dimensions; absent for external uris. */
  data?: Uint8Array;
  width?: number;
  height?: number;
}

export interface GlbStats {
  generator?: string;
  fileBytes: number;
  imageBytes: number;
  /** Drawn triangles, counting a mesh once per node that instances it. */
  triangles: number;
  /** Stored vertices, counting a shared mesh once. */
  vertices: number;
  meshes: number;
  nodes: number;
  materials: number;
  images: GlbImage[];
  extensions: string[];
  /** Axis-aligned extent in the glTF frame (Y up), in metres. */
  size?: [number, number, number];
  /** Spec violations that stop it rendering. */
  problems: string[];
}

export function parseGlb(buffer: ArrayBuffer): { json: Gltf; bin?: Uint8Array } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("not a GLB file");
  }
  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  let offset = 12;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const data = new Uint8Array(buffer, offset + 8, length);
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(data)) as Gltf;
    } else if (type === CHUNK_BIN) {
      bin = data;
    }
    offset += 8 + length;
  }
  if (!json) {
    throw new Error("GLB has no JSON chunk");
  }
  return { json, bin };
}

export function glbStats(buffer: ArrayBuffer): GlbStats {
  const { json, bin } = parseGlb(buffer);
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];

  const meshTriangles = meshes.map((mesh) => mesh.primitives.reduce((sum, primitive) => sum + primitiveTriangles(primitive, accessors), 0));
  const vertices = meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((s, p) => s + (accessorAt(accessors, p.attributes.POSITION)?.count ?? 0), 0), 0);

  const problems = meshes.flatMap((mesh, m) =>
    mesh.primitives.flatMap((primitive, p) => {
      const counts = Object.entries(primitive.attributes).map(([name, index]) => `${name} ${accessorAt(accessors, index)?.count}`);
      const distinct = new Set(counts.map((count) => count.split(" ")[1]));
      // The draw reads every attribute as far as the longest, so WebGL rejects it outright.
      return distinct.size > 1 ? [`mesh ${m} primitive ${p}: attribute counts differ (${counts.join(", ")})`] : [];
    }),
  );

  let triangles = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  walkScene(json, (node, world) => {
    if (node.mesh === undefined) {
      return;
    }
    triangles += meshTriangles[node.mesh] ?? 0;
    for (const primitive of meshes[node.mesh]?.primitives ?? []) {
      const position = accessorAt(accessors, primitive.attributes.POSITION);
      if (position?.min && position.max) {
        extendBounds(bounds, world, position.min, position.max);
      }
    }
  });

  const images = (json.images ?? []).map((image): GlbImage => {
    const bufferView = image.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
    const data = bufferView && bin ? bin.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength) : undefined;
    return { mimeType: image.mimeType ?? image.uri?.split(".").pop() ?? "?", bytes: data?.byteLength ?? 0, data };
  });

  return {
    generator: json.asset.generator,
    fileBytes: buffer.byteLength,
    imageBytes: images.reduce((sum, image) => sum + image.bytes, 0),
    triangles,
    vertices,
    meshes: meshes.length,
    nodes: json.nodes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    images,
    extensions: json.extensionsUsed ?? [],
    problems,
    size: Number.isFinite(bounds.min[0]) ? ([0, 1, 2].map((i) => bounds.max[i]! - bounds.min[i]!) as [number, number, number]) : undefined,
  };
}

function accessorAt(accessors: GltfAccessor[], index: number | undefined): GltfAccessor | undefined {
  return index === undefined ? undefined : accessors[index];
}

function primitiveTriangles(primitive: GltfPrimitive, accessors: GltfAccessor[]): number {
  const count = accessorAt(accessors, primitive.indices ?? primitive.attributes.POSITION)?.count ?? 0;
  switch (primitive.mode ?? MODE_TRIANGLES) {
    case MODE_TRIANGLES:
      return Math.floor(count / 3);
    case MODE_TRIANGLE_STRIP:
    case MODE_TRIANGLE_FAN:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

function walkScene(json: Gltf, visit: (node: GltfNode, world: Mat4) => void): void {
  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const walk = (index: number, parent: Mat4): void => {
    const node = nodes[index];
    if (!node) {
      return;
    }
    const world = multiply(parent, localMatrix(node));
    visit(node, world);
    for (const child of node.children ?? []) {
      walk(child, world);
    }
  };
  for (const root of roots) {
    walk(root, IDENTITY);
  }
}

// Column-major, as glTF stores them.
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) {
    return node.matrix;
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = Array.from({ length: 16 }, () => 0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function extendBounds(bounds: { min: number[]; max: number[] }, world: Mat4, min: number[], max: number[]): void {
  for (let corner = 0; corner < 8; corner++) {
    const p = [corner & 1 ? max[0]! : min[0]!, corner & 2 ? max[1]! : min[1]!, corner & 4 ? max[2]! : min[2]!];
    for (let i = 0; i < 3; i++) {
      const v = world[i]! * p[0]! + world[4 + i]! * p[1]! + world[8 + i]! * p[2]! + world[12 + i]!;
      bounds.min[i] = Math.min(bounds.min[i]!, v);
      bounds.max[i] = Math.max(bounds.max[i]!, v);
    }
  }
}
