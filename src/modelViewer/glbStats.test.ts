import { describe, expect, it } from "vitest";

import { glbStats, type Gltf } from "./glbStats";

function glb(json: Gltf, bin = new Uint8Array(0)): ArrayBuffer {
  const pad = (bytes: Uint8Array, fill: number): Uint8Array => {
    const out = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
    out.set(bytes);
    return out;
  };
  const jsonChunk = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const total = 12 + 8 + jsonChunk.byteLength + (binChunk.byteLength ? 8 + binChunk.byteLength : 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).set(jsonChunk);
  if (binChunk.byteLength) {
    const offset = 20 + jsonChunk.byteLength;
    view.setUint32(offset, binChunk.byteLength, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    new Uint8Array(buffer, offset + 8).set(binChunk);
  }
  return buffer;
}

describe("glbStats", () => {
  it("counts triangles per instance and vertices per mesh", () => {
    const stats = glbStats(
      glb({
        asset: { version: "2.0", generator: "test" },
        accessors: [{ count: 4, min: [-1, -1, 0], max: [1, 1, 0] }, { count: 6 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        nodes: [{ children: [1, 2] }, { mesh: 0, translation: [-2, 0, 0] }, { mesh: 0, translation: [2, 0, 0], scale: [1, 3, 1] }],
        scenes: [{ nodes: [0] }],
      }),
    );
    expect(stats.triangles).toBe(4);
    expect(stats.vertices).toBe(4);
    expect(stats.generator).toBe("test");
    expect(stats.size).toEqual([6, 6, 0]);
    expect(stats.problems).toEqual([]);
  });

  it("measures embedded images", () => {
    const stats = glbStats(
      glb(
        {
          asset: { version: "2.0" },
          bufferViews: [{ byteOffset: 4, byteLength: 8 }],
          images: [{ bufferView: 0, mimeType: "image/png" }],
        },
        new Uint8Array(12),
      ),
    );
    expect(stats.images).toHaveLength(1);
    expect(stats.images[0]?.bytes).toBe(8);
    expect(stats.imageBytes).toBe(8);
    expect(stats.size).toBeUndefined();
  });

  it("reports attributes of different lengths", () => {
    const stats = glbStats(
      glb({
        asset: { version: "2.0" },
        accessors: [{ count: 4 }, { count: 3 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
      }),
    );
    expect(stats.problems).toEqual(["mesh 0 primitive 0: attribute counts differ (POSITION 4, NORMAL 3)"]);
  });

  it("rejects a file that is not a GLB", () => {
    expect(() => glbStats(new ArrayBuffer(16))).toThrow("not a GLB");
  });
});
