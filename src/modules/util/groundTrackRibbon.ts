// A ground track as a ribbon over the sub-satellite points, every vertex stamped with
// its time, so a shader can clip the drawn stretch to the clock (GroundTrackBatch).

import { BoundingSphere, Cartesian3, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, type GeometryAttributes, PrimitiveType } from "@cesium/core";

/**
 * Metres above the ellipsoid. A 200 km edge sags 0.8 km below its ends, and Cesium's
 * depth plane hides what dips under the ellipsoid.
 */
export const RIBBON_HEIGHT_METERS = 3000;

/** The longest edge, along or across the track. Metres. */
export const RIBBON_EDGE_METERS = 200_000;

/** Under a metre apart, two sub-satellite points have no direction between them. */
const MIN_STEP_METERS = 1;

/** The name the shader reads the vertex times by. */
export const TRACK_SECONDS_ATTRIBUTE = "trackSeconds";

export interface RibbonSwath {
  /** To the right of the flight direction, metres. */
  starboardMeters: number;
  portMeters: number;
}

/**
 * `seconds` is per position and ascending, from an epoch the caller keeps; float32 on
 * the GPU, so keep it within a few thousand seconds. Undefined below two distinct
 * sub-satellite points: a geometry without a bounding sphere stops Cesium's render
 * loop (see `drawablePositions`).
 */
export function groundTrackRibbon(seconds: readonly number[], positions: readonly Cartesian3[], swath: RibbonSwath, ellipsoid = Ellipsoid.WGS84): Geometry | undefined {
  const centre = centreLine(seconds, positions, ellipsoid);
  const rows = centre.points.length;
  if (rows < 2) {
    return undefined;
  }
  const width = swath.starboardMeters + swath.portMeters;
  const columns = Math.max(1, Math.ceil(width / RIBBON_EDGE_METERS));
  const perRow = columns + 1;

  const vertexPositions = new Float64Array(rows * perRow * 3);
  const vertexSeconds = new Float32Array(rows * perRow);
  const tangent = new Cartesian3();
  const up = new Cartesian3();
  const starboard = new Cartesian3();
  const radial = new Cartesian3();
  const point = new Cartesian3();
  const lift = new Cartesian3();
  for (let row = 0; row < rows; row += 1) {
    const here = centre.points[row]!;
    Cartesian3.subtract(centre.points[Math.min(row + 1, rows - 1)]!, centre.points[Math.max(row - 1, 0)]!, tangent);
    ellipsoid.geodeticSurfaceNormal(here, up);
    Cartesian3.normalize(Cartesian3.cross(tangent, up, starboard), starboard);
    // Across the track along a great circle, so a wide swath bends with the Earth.
    const radius = Cartesian3.magnitude(here);
    Cartesian3.normalize(here, radial);
    Cartesian3.normalize(Cartesian3.subtract(starboard, Cartesian3.multiplyByScalar(radial, Cartesian3.dot(starboard, radial), point), starboard), starboard);
    for (let column = 0; column < perRow; column += 1) {
      const angle = (-swath.portMeters + (column * width) / columns) / radius;
      Cartesian3.add(Cartesian3.multiplyByScalar(radial, Math.cos(angle) * radius, point), Cartesian3.multiplyByScalar(starboard, Math.sin(angle) * radius, lift), point);
      ellipsoid.scaleToGeodeticSurface(point, point);
      Cartesian3.add(point, Cartesian3.multiplyByScalar(ellipsoid.geodeticSurfaceNormal(point, lift), RIBBON_HEIGHT_METERS, lift), point);
      const vertex = row * perRow + column;
      Cartesian3.pack(point, vertexPositions as unknown as number[], vertex * 3);
      vertexSeconds[vertex] = centre.seconds[row]!;
    }
  }

  const indices = rows * perRow > 0xffff ? new Uint32Array((rows - 1) * columns * 6) : new Uint16Array((rows - 1) * columns * 6);
  let at = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * perRow + column;
      const b = a + perRow;
      indices[at++] = a;
      indices[at++] = b;
      indices[at++] = a + 1;
      indices[at++] = a + 1;
      indices[at++] = b;
      indices[at++] = b + 1;
    }
  }

  return new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: vertexPositions }),
      [TRACK_SECONDS_ATTRIBUTE]: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: vertexSeconds }),
    } as unknown as GeometryAttributes,
    indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(vertexPositions as unknown as number[]),
  });
}

/** The sub-satellite points, at most `RIBBON_EDGE_METERS` apart, and their times. */
function centreLine(seconds: readonly number[], positions: readonly Cartesian3[], ellipsoid: Ellipsoid): { points: Cartesian3[]; seconds: number[] } {
  const subpoints: Cartesian3[] = [];
  const times: number[] = [];
  for (const [index, position] of positions.entries()) {
    const subpoint = ellipsoid.scaleToGeodeticSurface(position, new Cartesian3());
    const previous = subpoints[subpoints.length - 1];
    if (!subpoint || (previous && Cartesian3.distance(previous, subpoint) < MIN_STEP_METERS)) {
      continue;
    }
    subpoints.push(subpoint);
    times.push(seconds[index]!);
  }

  const points: Cartesian3[] = [];
  const pointSeconds: number[] = [];
  for (let index = 0; index < subpoints.length - 1; index += 1) {
    const from = subpoints[index]!;
    const to = subpoints[index + 1]!;
    const steps = Math.ceil(Cartesian3.distance(from, to) / RIBBON_EDGE_METERS);
    for (let step = 0; step < steps; step += 1) {
      const share = step / steps;
      const between = Cartesian3.lerp(from, to, share, new Cartesian3());
      points.push(ellipsoid.scaleToGeodeticSurface(between, between) ?? between);
      pointSeconds.push(times[index]! + share * (times[index + 1]! - times[index]!));
    }
  }
  if (subpoints.length > 1) {
    points.push(subpoints[subpoints.length - 1]!);
    pointSeconds.push(times[times.length - 1]!);
  }
  return { points, seconds: pointSeconds };
}
