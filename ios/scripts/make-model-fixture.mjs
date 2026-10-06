#!/usr/bin/env node
// Write the 3D model fixture the renderer's tests read (Fixtures/cube.glb): a unit
// cube with normals and texture coordinates, Draco-compressed as every model in
// data/models is (KHR_draco_mesh_compression), textured with a 2×2 PNG, under a
// node that scales it by 2 and lifts it by 1 along +Z. Made here rather than taken
// from data/models so the tests carry no third party's model. Run from the
// repository root: `node ios/scripts/make-model-fixture.mjs`. draco3d comes with
// CesiumJS, and is resolved through it.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(createRequire(path.resolve("package.json")).resolve("@cesium/engine"));
const draco3d = require("draco3d");
const output = path.resolve("ios/SatvisKit/Tests/SatvisRenderTests/Fixtures/cube.glb");

// Four corners a face, each face its own normal, so the normals stay flat.
const faces = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];
const positions = [];
const normals = [];
const uvs = [];
const indices = [];
for (const [normal, u, v] of faces) {
  const base = positions.length / 3;
  for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    positions.push(...normal.map((n, i) => 0.5 * (n + s * u[i] + t * v[i])));
    normals.push(...normal);
    uvs.push((s + 1) / 2, (t + 1) / 2);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const encoderModule = await draco3d.createEncoderModule({});
const builder = new encoderModule.MeshBuilder();
const mesh = new encoderModule.Mesh();
builder.AddFacesToMesh(mesh, indices.length / 3, new Uint32Array(indices));
const attributes = {
  POSITION: builder.AddFloatAttributeToMesh(mesh, encoderModule.POSITION, 24, 3, new Float32Array(positions)),
  NORMAL: builder.AddFloatAttributeToMesh(mesh, encoderModule.NORMAL, 24, 3, new Float32Array(normals)),
  TEXCOORD_0: builder.AddFloatAttributeToMesh(mesh, encoderModule.TEX_COORD, 24, 2, new Float32Array(uvs)),
};
const encoder = new encoderModule.Encoder();
encoder.SetAttributeQuantization(encoderModule.POSITION, 14);
encoder.SetAttributeQuantization(encoderModule.NORMAL, 10);
encoder.SetAttributeQuantization(encoderModule.TEX_COORD, 12);
const encoded = new encoderModule.DracoInt8Array();
const length = encoder.EncodeMeshToDracoBuffer(mesh, encoded);
const draco = Buffer.alloc(length);
for (let i = 0; i < length; i++) {
  draco[i] = encoded.GetValue(i);
}

// A 2×2 RGBA PNG: red, green / blue, white.
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(2, 4);
header.set([8, 6, 0, 0, 0], 8);
const rows = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);

const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)]);
const dracoPadded = pad(draco, 0);
const bin = pad(Buffer.concat([dracoPadded, png]), 0);
const accessor = (type, extra) => ({ componentType: 5126, count: 24, type, ...extra });
const gltf = {
  asset: { version: "2.0", generator: "ios/scripts/make-model-fixture.mjs" },
  extensionsUsed: ["KHR_draco_mesh_compression"],
  extensionsRequired: ["KHR_draco_mesh_compression"],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, translation: [0, 0, 1], scale: [2, 2, 2] }],
  meshes: [
    {
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
          indices: 3,
          material: 0,
          extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes } },
        },
      ],
    },
  ],
  accessors: [
    accessor("VEC3", { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
    accessor("VEC3"),
    accessor("VEC2"),
    { componentType: 5123, count: indices.length, type: "SCALAR" },
  ],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
  textures: [{ source: 0 }],
  images: [{ bufferView: 1, mimeType: "image/png" }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: draco.length },
    { buffer: 0, byteOffset: dracoPadded.length, byteLength: png.length },
  ],
  buffers: [{ byteLength: bin.length }],
};
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const glbHeader = Buffer.alloc(12);
glbHeader.write("glTF", 0);
glbHeader.writeUInt32LE(2, 4);
glbHeader.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunkHeader = (length, type) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(length, 0);
  head.write(type, 4);
  return head;
};
fs.writeFileSync(output, Buffer.concat([glbHeader, chunkHeader(json.length, "JSON"), json, chunkHeader(bin.length, "BIN\0"), bin]));
console.log(`Wrote ${path.relative(process.cwd(), output)} (${12 + 8 + json.length + 8 + bin.length} bytes)`);
