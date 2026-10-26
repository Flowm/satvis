// Many satellites' orbit lines in one instanced draw call: each segment an instance, widened
// in the vertex shader to one CSS pixel with edges fading over a device pixel, as the native
// app's Lines.msl draws them. A `PolylineGeometry` took 1,338 MB for all active orbits;
// `gl.LINES` is one device pixel wide and aliased.
//
// - "inertial" (the Orbit component): the ellipse is fixed in inertial space, so a
//   model matrix re-orients it every frame and only a member's change uploads.
// - "fixed" (the Orbit track component): an Earth-relative track is no rigid transform
//   of itself, so the owner swaps a member's points through `replace`.
//
// Every line has a slot of POINTS_PER_SLOT points, so a change uploads one slot. A slot's
// unused points have w = 0, and a segment with such an end draws nothing, which also
// keeps a slot's last point from joining the next slot's first.

import { BoundingSphere, Cartesian3, type Color, ComponentDatatype, type JulianDate, Matrix3, Matrix4, PrimitiveType, defined } from "@cesium/core";
import * as Engine from "@cesium/engine";
import { BlendingState, SceneMode, Transforms } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { SAMPLES_PER_ORBIT } from "./trajectoryWindow";

/** Which frame a batch's points are in; see the file header. */
export type BatchFrame = "inertial" | "fixed";

/** A line's samples, its head twice and room to spare; a longer line is cut short. */
export const POINTS_PER_SLOT = SAMPLES_PER_ORBIT + 8;

/** x, y, z and the flag that the point is part of a line. */
const FLOATS_PER_POINT = 4;

/** One slot's floats in the points buffer. */
const FLOATS_PER_SLOT = POINTS_PER_SLOT * FLOATS_PER_POINT;

/** CSS pixels: two device pixels on a phone or an iPad, as the native app draws them. */
const LINE_WIDTH = 1;

/** Slots added beyond those needed when the buffer grows, so a build does not reallocate per satellite. */
const GROWTH = 1.5;

/** Changed slots this close are uploaded as one run, the unchanged ones between them included. */
const RUN_GAP = 8;

/** One line in a batch: its points in the batch's frame, packed as float32 x, y, z. */
export class BatchedLine {
  /** The first POINTS_PER_SLOT - 1, so the slot's last point stays a break. */
  readonly points: Float32Array;

  /** Distance of the farthest point from the centre of the Earth, metres. */
  readonly radius: number;

  /** Packs `positions`, cut short past a slot; `id` names the line's satellite. */
  constructor(
    positions: readonly Cartesian3[],
    readonly id: string,
  ) {
    const count = Math.min(positions.length, POINTS_PER_SLOT - 1);
    this.points = new Float32Array(count * 3);
    let radius = 0;
    for (let i = 0; i < count; i += 1) {
      const { x, y, z } = positions[i]!;
      this.points.set([x, y, z], i * 3);
      radius = Math.max(radius, Math.hypot(x, y, z));
    }
    this.radius = radius;
  }
}

/** Which slot each line has, and which slots changed. Cesium-free, so it is tested without WebGL. */
export class LineSlots {
  /** The line in each slot, undefined where a slot is free. */
  #lines: (BatchedLine | undefined)[] = [];

  /** Freed slots, the last freed first: a recreate (a remove, then an add) keeps its slot. */
  #free: number[] = [];

  /** Each line's slot. */
  #slotOf = new Map<BatchedLine, number>();

  /** Slots changed since the last `takeDirty`. */
  #dirty = new Set<number>();

  /** The lines held. */
  get size(): number {
    return this.#slotOf.size;
  }

  /** One past the highest slot in use: the slots drawn. */
  get extent(): number {
    return this.#lines.length;
  }

  /** Whether a slot changed since the last `takeDirty`. */
  get dirty(): boolean {
    return this.#dirty.size > 0;
  }

  /** Whether `line` has a slot. */
  has(line: BatchedLine): boolean {
    return this.#slotOf.has(line);
  }

  /** Gives `line` the last freed slot, or a new one at the end. */
  add(line: BatchedLine): void {
    const slot = this.#free.pop() ?? this.#lines.length;
    this.#lines[slot] = line;
    this.#slotOf.set(line, slot);
    this.#dirty.add(slot);
  }

  /** Frees `line`'s slot; false when it has none. */
  remove(line: BatchedLine): boolean {
    const slot = this.#slotOf.get(line);
    if (slot === undefined) {
      return false;
    }
    this.#slotOf.delete(line);
    this.#lines[slot] = undefined;
    this.#free.push(slot);
    this.#dirty.add(slot);
    this.#trim();
    return true;
  }

  /** Puts `next` in `previous`'s slot; false when `previous` has none. */
  replace(previous: BatchedLine, next: BatchedLine): boolean {
    const slot = this.#slotOf.get(previous);
    if (slot === undefined) {
      return false;
    }
    this.#slotOf.delete(previous);
    this.#slotOf.set(next, slot);
    this.#lines[slot] = next;
    this.#dirty.add(slot);
    return true;
  }

  /** The changed slots since the last call, in order. */
  takeDirty(): number[] {
    const slots = [...this.#dirty].filter((slot) => slot < this.#lines.length).toSorted((a, b) => a - b);
    this.#dirty.clear();
    return slots;
  }

  /** Writes slot `slot` at `offset` floats into `out`: the line's points with w = 1, then breaks. */
  write(slot: number, out: Float32Array, offset = 0): void {
    out.fill(0, offset, offset + FLOATS_PER_SLOT);
    const points = this.#lines[slot]?.points;
    if (!points) {
      return;
    }
    for (let i = 0, count = points.length / 3; i < count; i += 1) {
      const at = offset + i * FLOATS_PER_POINT;
      out[at] = points[i * 3]!;
      out[at + 1] = points[i * 3 + 1]!;
      out[at + 2] = points[i * 3 + 2]!;
      out[at + 3] = 1;
    }
  }

  /** Every slot up to the extent, packed for one upload. */
  writeAll(capacity: number): Float32Array {
    const out = new Float32Array(capacity * FLOATS_PER_SLOT);
    for (let slot = 0; slot < this.#lines.length; slot += 1) {
      this.write(slot, out, slot * FLOATS_PER_SLOT);
    }
    return out;
  }

  /** Drops trailing empty slots, so the draw stops at the last line. */
  #trim(): void {
    while (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] === undefined) {
      const slot = this.#lines.length - 1;
      this.#lines.pop();
      this.#free = this.#free.filter((free) => free !== slot);
    }
  }
}

/** Sorted slots as inclusive [first, last] runs, merging gaps up to RUN_GAP. */
export function slotRuns(sorted: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const slot of sorted) {
    const run = runs[runs.length - 1];
    if (run && slot - run[1] <= RUN_GAP) {
      run[1] = slot;
    } else {
      runs.push([slot, slot]);
    }
  }
  return runs;
}

/** Widens the segment from `pointA` to `pointB` into a band `u_width` CSS pixels wide, half a pixel more either side. */
const VERTEX_SHADER = `
in vec2 corner;
in vec4 pointA;
in vec4 pointB;

uniform float u_width;

out float v_across;
out float v_halfWidth;

vec4 clipPosition(vec3 position) {
    return czm_modelViewProjectionRelativeToEye * czm_translateRelativeToEye(position, vec3(0.0));
}

void main() {
    v_halfWidth = 0.5 * u_width * czm_pixelRatio;
    // Half a pixel more either side, where the fade ends: every fragment past it is discarded.
    float reach = v_halfWidth + 0.5;
    v_across = corner.y * reach;
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    if (pointA.w == 0.0 || pointB.w == 0.0) {
        return;
    }
    vec4 a = clipPosition(pointA.xyz);
    vec4 b = clipPosition(pointB.xyz);
    // Clip space is linear along the segment: cut it at the near plane.
    float near = czm_currentFrustum.x * 1.001;
    if (a.w < near && b.w < near) {
        return;
    }
    if (a.w < near) {
        a = mix(a, b, (near - a.w) / (b.w - a.w));
    } else if (b.w < near) {
        b = mix(b, a, (near - b.w) / (a.w - b.w));
    }
    vec2 halfViewport = 0.5 * czm_viewport.zw;
    vec2 along = b.xy / b.w * halfViewport - a.xy / a.w * halfViewport;
    float span = length(along);
    vec2 direction = span > 0.0 ? along / span : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);
    vec4 position = corner.x < 0.5 ? a : b;
    position.xy += normal * v_across / halfViewport * position.w;
    gl_Position = position;
}
`;

/** Fades the band's edges by how much of each pixel it covers. */
const FRAGMENT_SHADER = `
uniform vec4 u_color;

in float v_across;
in float v_halfWidth;

void main() {
    // The share of the pixel the line covers, with its edges a pixel soft.
    float coverage = clamp(v_halfWidth + 0.5 - abs(v_across), 0.0, 1.0);
    if (coverage <= 0.0) {
        discard;
    }
    out_FragColor = czm_gammaCorrect(vec4(u_color.rgb, u_color.a * coverage));
}
`;

/** The shaders' attribute locations. */
const ATTRIBUTES = { corner: 0, pointA: 1, pointB: 2 };

/** A triangle strip across the segment: its start, then its end, each on both sides. */
const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The renderer classes Cesium exports but leaves out of its typings; only what is used. */
interface CesiumRenderer {
  Buffer: { createVertexBuffer(options: { context: any; typedArray: Float32Array; usage: number }): any };
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number };
  VertexArray: new (options: { context: any; attributes: object[] }) => any;
  ShaderProgram: { fromCache(options: { context: any; vertexShaderSource: string; fragmentShaderSource: string; attributeLocations: object }): any };
  RenderState: { fromCache(state: object): any };
  DrawCommand: new (options: object) => any;
  Pass: { TRANSLUCENT: number };
}
const { Buffer, BufferUsage, VertexArray, ShaderProgram, RenderState, DrawCommand, Pass } = Engine as unknown as CesiumRenderer;

/** The members' lines, drawn by a primitive in the scene. Changes reach the GPU on the next rendered frame. */
export class PolylineBatch {
  /** The viewer whose scene draws the batch. */
  readonly #viewer: Viewer;

  /** The frame the members' points are in. */
  readonly #frame: BatchFrame;

  /** Every member's colour. */
  readonly #color: Color;

  /** The members and their slots in the points buffer. */
  readonly #slots = new LineSlots();

  /** `settled` calls waiting for the next upload. */
  #settledWaiters: Array<() => void> = [];

  /** The farthest point of any line so far, metres; the bound only grows. */
  #radius = 0;

  /** The corner and points buffers and the vertex array over them; `capacity` in slots. Undefined while empty. */
  #gpu: { corners: any; points: any; vertexArray: any; capacity: number } | undefined;

  /** Built with the draw command, on the first frame drawn. */
  #shaderProgram: any;

  /** Reused every frame; see `#drawCommand`. */
  #command: any;

  /** The inertial batch's turn into the fixed frame; the identity for a fixed one. */
  #modelMatrix = Matrix4.clone(Matrix4.IDENTITY);

  /** Set by `destroy`, for the scene's `isDestroyed`. */
  #destroyed = false;

  /** Read by the scene. */
  show = true;

  /** Adds the batch to `viewer`'s scene, its lines in `frame` and drawn in `color`. */
  constructor(viewer: Viewer, frame: BatchFrame, color: Color) {
    this.#viewer = viewer;
    this.#frame = frame;
    this.#color = color;
    viewer.scene.primitives.add(this);
  }

  /** Changes not yet on the GPU. */
  get pending(): boolean {
    return this.#slots.dirty;
  }

  /** The members. */
  get size(): number {
    return this.#slots.size;
  }

  /** Draws `line` from the next rendered frame. */
  add(line: BatchedLine): void {
    this.#slots.add(line);
    this.#radius = Math.max(this.#radius, line.radius);
    this.#viewer.scene.requestRender();
  }

  /** Stops drawing `line`, if it is a member. */
  remove(line: BatchedLine): void {
    if (this.#slots.remove(line)) {
      this.#viewer.scene.requestRender();
    }
  }

  /**
   * Draws `next` in place of `previous`. Returns false when `previous` is not a member (its
   * component was disabled before the refresh ran), so the caller can drop `next` instead of
   * leaking it.
   */
  replace(previous: BatchedLine, next: BatchedLine): boolean {
    if (!this.#slots.replace(previous, next)) {
      return false;
    }
    this.#radius = Math.max(this.#radius, next.radius);
    this.#viewer.scene.requestRender();
    return true;
  }

  /**
   * Resolves once the GPU holds every change. The scene morph waits on it: morphing
   * first would draw the lines into the projection being left.
   */
  settled(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#settledWaiters.push(resolve);
    });
  }

  /** Called by the scene on every rendered frame. */
  update(frameState: any): void {
    if (!this.show || this.#destroyed) {
      return;
    }
    const { context } = frameState;
    if (!context.instancedArrays) {
      return;
    }
    this.#upload(context);
    if (this.#settledWaiters.length > 0) {
      const waiters = this.#settledWaiters;
      this.#settledWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
    // A batch draws only in 3D; elsewhere its members are paths.
    const extent = this.#slots.extent;
    if (!this.#gpu || extent === 0 || frameState.mode !== SceneMode.SCENE3D || !frameState.passes.render) {
      return;
    }
    this.#orient(frameState.time);
    const command = this.#drawCommand(context);
    command.vertexArray = this.#gpu.vertexArray;
    command.instanceCount = extent * POINTS_PER_SLOT - 1;
    command.boundingVolume = new BoundingSphere(Cartesian3.ZERO, this.#radius);
    frameState.commandList.push(command);
  }

  /**
   * The changed slots, in runs: a build appends hundreds a frame, a refill changes a few
   * scattered ones. The buffer is reallocated only to grow.
   */
  #upload(context: any): void {
    if (!this.#slots.dirty) {
      return;
    }
    const extent = this.#slots.extent;
    const dirty = this.#slots.takeDirty();
    // Emptied: nothing to draw, and a buffer cannot be empty.
    if (extent === 0) {
      this.#release();
      return;
    }
    if (!this.#gpu || this.#gpu.capacity < extent) {
      this.#allocate(context, Math.ceil(extent * GROWTH));
      return;
    }
    for (const [first, last] of slotRuns(dirty)) {
      const run = new Float32Array((last - first + 1) * FLOATS_PER_SLOT);
      for (let slot = first; slot <= last; slot += 1) {
        this.#slots.write(slot, run, (slot - first) * FLOATS_PER_SLOT);
      }
      this.#gpu.points.copyFromArrayView(run, first * FLOATS_PER_SLOT * Float32Array.BYTES_PER_ELEMENT);
    }
  }

  /** Replaces the points buffer with one of `capacity` slots holding every member, and the vertex array over it. */
  #allocate(context: any, capacity: number): void {
    const corners = this.#gpu?.corners ?? Buffer.createVertexBuffer({ context, typedArray: CORNERS, usage: BufferUsage.STATIC_DRAW });
    if (this.#gpu) {
      this.#gpu.vertexArray.destroy();
      this.#gpu.points.destroy();
    }
    const points = Buffer.createVertexBuffer({ context, typedArray: this.#slots.writeAll(capacity), usage: BufferUsage.DYNAMIC_DRAW });
    // A vertex array destroys its buffers with it unless told not to, and the corners outlive it.
    corners.vertexArrayDestroyable = false;
    points.vertexArrayDestroyable = false;
    const stride = FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
    const pointAttribute = (index: number, offsetInBytes: number) => ({
      index,
      vertexBuffer: points,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.FLOAT,
      offsetInBytes,
      strideInBytes: stride,
      instanceDivisor: 1,
    });
    const vertexArray = new VertexArray({
      context,
      attributes: [
        { index: ATTRIBUTES.corner, vertexBuffer: corners, componentsPerAttribute: 2, componentDatatype: ComponentDatatype.FLOAT },
        // The same buffer twice, a point apart: instance i is the segment from point i to i + 1.
        pointAttribute(ATTRIBUTES.pointA, 0),
        pointAttribute(ATTRIBUTES.pointB, stride),
      ],
    });
    this.#gpu = { corners, points, vertexArray, capacity };
  }

  /** The draw command, built once: the shader, render state and uniforms never change. */
  #drawCommand(context: any): any {
    if (this.#command) {
      return this.#command;
    }
    this.#shaderProgram = ShaderProgram.fromCache({
      context,
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: FRAGMENT_SHADER,
      attributeLocations: ATTRIBUTES,
    });
    const color = this.#color;
    this.#command = new DrawCommand({
      owner: this,
      primitiveType: PrimitiveType.TRIANGLE_STRIP,
      count: CORNERS.length / 2,
      shaderProgram: this.#shaderProgram,
      renderState: RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, blending: BlendingState.ALPHA_BLEND }),
      uniformMap: { u_color: () => color, u_width: () => LINE_WIDTH },
      pass: Pass.TRANSLUCENT,
      modelMatrix: this.#modelMatrix,
    });
    return this.#command;
  }

  /** The inertial batch turns with the Earth; until the IAU data loads it keeps its last turn. */
  #orient(time: JulianDate): void {
    if (this.#frame === "fixed") {
      return;
    }
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time, PolylineBatch.#rotationScratch);
    if (defined(icrfToFixed)) {
      Matrix4.fromRotationTranslation(icrfToFixed, Cartesian3.ZERO, this.#modelMatrix);
    }
  }

  /** `#orient`'s rotation, reused every frame. */
  static readonly #rotationScratch = new Matrix3();

  /** Read by the scene. */
  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Called by the scene when the batch is removed: frees the GPU resources. */
  destroy(): undefined {
    this.#release();
    this.#shaderProgram?.destroy();
    this.#destroyed = true;
    return undefined;
  }

  /** Frees the buffers; the next line added allocates them again. */
  #release(): void {
    this.#gpu?.vertexArray.destroy();
    this.#gpu?.points.destroy();
    this.#gpu?.corners.destroy();
    this.#gpu = undefined;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
