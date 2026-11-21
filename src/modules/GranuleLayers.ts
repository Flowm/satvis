// Granule layers on the globe (ADR 0023): CMR lists the granules and their outlines, and
// for a GIBS layer of one granule a frame, GIBS draws each one's pixels, transparent outside
// it, as a layer of its own. A `cmr` layer has the outlines alone. Where its satellite is
// drawn, the granule under it fills in behind its scan line, the swath fan's.

import {
  Cartesian3,
  Cartesian4,
  type Clock,
  Color,
  ColorGeometryInstanceAttribute,
  Ellipsoid,
  GeometryInstance,
  JulianDate,
  PolygonGeometry,
  PolygonHierarchy,
} from "@cesium/core";
import {
  GroundPolylineGeometry,
  GroundPolylinePrimitive,
  GroundPrimitive,
  ImageryLayer,
  Material,
  MaterialAppearance,
  PolylineColorAppearance,
  type PrimitiveCollection,
  type Scene,
  type TileProviderError,
} from "@cesium/engine";

import { gibsPictureUrl, type GranuleLayer, type TiledImagery } from "@/config/instrumentImagery";
import { fetchGranules, type Granule, granuleExtent } from "@/modules/util/cmrGranules";
import { formatFrame } from "@/modules/util/timeDomain";

import { trackRequests } from "./FramedImagery";
import { gibsFrames, gibsHasGranule } from "./GibsImagery";
import type { GranuleOutlines, GranulePixels, GranuleSensing, GranuleSource } from "./GranuleImagery";
import type { ScanPlane } from "./satelliteGraphics";

/** A granule's outline on the ground; its primitive is replaced when it is marked missing. */
export interface GranuleOutline {
  granule: Granule;
  primitive: GroundPolylinePrimitive;
}

/** A granule filling in behind the scan line. */
export interface GranuleFill {
  primitive: GroundPrimitive;
  material: Material;
  /** Set once it is taken off, so a picture that arrives later is dropped. */
  gone: boolean;
}

/** An outline with pixels inside it, or of a layer of outlines alone, and one whose pixels the provider does not have. */
const OUTLINE_COLOR = Color.fromCssColorString("#ffd54a").withAlpha(0.9);
const MISSING_COLOR = Color.fromCssColorString("#9e9e9e").withAlpha(0.7);

/** A fill where it has no picture: the outlines' colour, faint, yet seen over land. */
const FILL_TINT = Color.fromCssColorString("#ffd54a").withAlpha(0.35);

/** Pixels. */
const OUTLINE_WIDTH = 2;

/** Times a tile GIBS failed to send is asked for again. */
const TILE_RETRIES = 2;

/** Pixels across a granule's picture while it fills: 577 KB for a NOAA 20 granule as JPEG, 5 MB as PNG (measured 2026-11-21). */
const PICTURE_WIDTH = 2048;

/** Degrees of longitude past which a granule, near a pole, gets no picture while it fills: a plate carrée one would be mostly stretch. */
const PICTURE_MAX_SPAN = 90;

/** Degrees padded around a granule's picture, so its edge is never sampled at the outline. */
const PICTURE_MARGIN = 0.5;

/** WGS84's 1 - e², from geocentric to geodetic latitude on the surface. */
const POLAR_RATIO_SQUARED = (Ellipsoid.WGS84.radii.z / Ellipsoid.WGS84.radii.x) ** 2;

/**
 * Discards what lies ahead of the scan line until the granule is passed; inside the swath,
 * its picture, sampled by latitude and longitude, over the tint. GIBS's JPEG is black where
 * the granule has no pixels: that is no picture.
 */
const FILL_SHADER = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  // As ShadowVolumeAppearanceFS finds it: its positionToEyeEC is scaled by 1/depth under log depth.
  float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
  vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
  vec3 world = (czm_inverseView * vec4(eye.xyz / eye.w, 1.0)).xyz;
  if (passed < 0.5 && dot(world - scanPoint, scanAhead) > 0.0) {
    discard;
  }
  vec4 colour = tint;
  if (picture > 0.5) {
    float longitude = atan(world.y, world.x);
    if (longitude < bounds.x) {
      longitude += czm_twoPi;
    }
    float latitude = atan(world.z, ${POLAR_RATIO_SQUARED.toFixed(9)} * length(world.xy));
    vec4 texel = texture(image, (vec2(longitude, latitude) - bounds.xy) / (bounds.zw - bounds.xy));
    if (max(texel.r, max(texel.g, texel.b)) > 0.02) {
      colour = vec4(texel.rgb, 1.0);
    }
  }
  material.diffuse = colour.rgb;
  material.alpha = colour.a;
  return material;
}
`;

function outlinePrimitive(granule: Granule, color: Color): GroundPolylinePrimitive {
  return new GroundPolylinePrimitive({
    geometryInstances: new GeometryInstance({
      geometry: new GroundPolylineGeometry({
        positions: Cartesian3.fromDegreesArray(granule.outline.flatMap(({ latitude, longitude }) => [longitude, latitude])),
        width: OUTLINE_WIDTH,
      }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    }),
    appearance: new PolylineColorAppearance(),
    // A click on an outline would otherwise reach the Viewer's selection and clear it.
    allowPicking: false,
    asynchronous: true,
  });
}

/** GIBS's pixels of the granules of `drawn`, a layer of one granule a frame. */
function gibsPixels(drawn: TiledImagery, primitives: PrimitiveCollection): GranulePixels<ImageryLayer, GranuleOutline> {
  const options = { layer: drawn.layer, maximumLevel: drawn.maxLevel, format: drawn.format, daily: false };
  const frames = gibsFrames(options);
  return {
    has: (granule) => gibsHasGranule(options, granule.start),
    layer: (granule) => {
      const provider = frames.show(granule.start);
      // GIBS answers some of the tiles of several granules asked for at once with a 500
      // that a second request gets (measured 2026-11-21: 7 of 461).
      provider.errorEvent.addEventListener((error: TileProviderError) => {
        error.retry = error.timesRetried < TILE_RETRIES;
      });
      return { layer: new ImageryLayer(provider), loaded: trackRequests(provider) };
    },
    markMissing: (outline) => {
      if (primitives.contains(outline.primitive)) {
        primitives.remove(outline.primitive);
        outline.primitive = primitives.add(outlinePrimitive(outline.granule, MISSING_COLOR)) as GroundPolylinePrimitive;
      }
    },
  };
}

/** Where the satellite a granule layer belongs to scans at a time, while it is drawn. */
export interface GranuleFollow {
  scan: (time: JulianDate) => ScanPlane | undefined;
  clock: Clock;
  scene: Scene;
  /** Ends the following. */
  signal: AbortSignal;
}

/** The granule's picture while it fills, where GIBS has its pixels and it is not near a pole. */
async function loadPicture(drawn: TiledImagery, granule: Granule, fill: GranuleFill): Promise<void> {
  const extent = granuleExtent(granule);
  const span = extent.east - extent.west;
  // GIBS's WMS draws nothing for a box across the antimeridian.
  if (span > PICTURE_MAX_SPAN || extent.west < -180 || extent.east > 180) {
    return;
  }
  if (!(await gibsHasGranule({ layer: drawn.layer, maximumLevel: drawn.maxLevel, format: drawn.format }, granule.start)) || fill.gone) {
    return;
  }
  const bounds = {
    west: Math.max(-180, extent.west - PICTURE_MARGIN),
    south: Math.max(-90, extent.south - PICTURE_MARGIN),
    east: Math.min(180, extent.east + PICTURE_MARGIN),
    north: Math.min(90, extent.north + PICTURE_MARGIN),
  };
  const height = Math.round((PICTURE_WIDTH * (bounds.north - bounds.south)) / (bounds.east - bounds.west));
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = gibsPictureUrl(drawn.layer, formatFrame(granule.start, false), bounds, PICTURE_WIDTH, Math.min(PICTURE_WIDTH, Math.max(1, height)));
  try {
    await image.decode();
  } catch {
    return;
  }
  if (fill.gone) {
    return;
  }
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  fill.material.uniforms.bounds = new Cartesian4(radians(bounds.west), radians(bounds.south), radians(bounds.east), radians(bounds.north));
  fill.material.uniforms.image = image;
  fill.material.uniforms.picture = 1;
}

/** The granules of `drawn` filling in behind its satellite's scan line. */
function sensing(drawn: GranuleLayer, primitives: PrimitiveCollection, follow: GranuleFollow): GranuleSensing<GranuleFill> {
  const fills = new Set<GranuleFill>();
  const corners = new WeakMap<Granule, Cartesian3[]>();
  const cornersOf = (granule: Granule) => {
    let found = corners.get(granule);
    if (found === undefined) {
      found = granule.outline.map(({ latitude, longitude }) => Cartesian3.fromDegrees(longitude, latitude));
      corners.set(granule, found);
    }
    return found;
  };
  // The scan line is asked for at each granule's every tick: once a time. Not kept while
  // there is none, as the satellite's samples of a time the clock jumped to come later.
  let scanAt: number | undefined;
  let scan: ScanPlane | undefined;
  const scanFor = (time: number) => {
    if (scanAt !== time || scan === undefined) {
      scanAt = time;
      scan = follow.scan(JulianDate.fromDate(new Date(time)));
    }
    return scan;
  };
  const offset = new Cartesian3();

  const removeListener = follow.scene.preRender.addEventListener(() => {
    const plane = scanFor(JulianDate.toDate(follow.clock.currentTime).getTime());
    if (plane === undefined) {
      return;
    }
    for (const { material } of fills) {
      material.uniforms.scanPoint = plane.point;
      material.uniforms.scanAhead = plane.ahead;
    }
  });
  follow.signal.addEventListener("abort", removeListener, { once: true });

  return {
    passed: (granule, time) => {
      const plane = scanFor(time);
      return plane && cornersOf(granule).every((corner) => Cartesian3.dot(Cartesian3.subtract(corner, plane.point, offset), plane.ahead) < 0);
    },
    show: (granule) => {
      const material = new Material({
        fabric: {
          uniforms: {
            image: Material.DefaultImageId,
            bounds: new Cartesian4(),
            scanPoint: new Cartesian3(),
            scanAhead: new Cartesian3(),
            tint: FILL_TINT,
            passed: 0,
            picture: 0,
          },
          source: FILL_SHADER,
        },
        translucent: true,
      });
      const primitive = new GroundPrimitive({
        geometryInstances: new GeometryInstance({
          geometry: new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(cornersOf(granule).slice(0, -1)) }),
        }),
        appearance: new MaterialAppearance({ material, flat: true }),
        allowPicking: false,
        asynchronous: true,
      });
      const fill: GranuleFill = { primitive, material, gone: false };
      const plane = scanFor(JulianDate.toDate(follow.clock.currentTime).getTime());
      if (plane !== undefined) {
        material.uniforms.scanPoint = plane.point;
        material.uniforms.scanAhead = plane.ahead;
      }
      primitives.add(primitive);
      fills.add(fill);
      if (drawn.provider !== "cmr") {
        void loadPicture(drawn, granule, fill);
      }
      return fill;
    },
    setPassed: (fill, passed) => {
      fill.material.uniforms.passed = passed ? 1 : 0;
    },
    hide: (fill) => {
      fill.gone = true;
      fills.delete(fill);
      primitives.remove(fill.primitive);
    },
  };
}

/**
 * The services behind `drawn`, a layer with CMR collections, and where its outlines go;
 * with `follow`, its granules fill in behind the satellite's scan line.
 */
export function granuleLayer(
  drawn: GranuleLayer,
  primitives: PrimitiveCollection,
  follow?: GranuleFollow,
): { source: GranuleSource<ImageryLayer, GranuleOutline, GranuleFill>; outlines: GranuleOutlines<GranuleOutline> } {
  const source: GranuleSource<ImageryLayer, GranuleOutline, GranuleFill> = {
    name: drawn.layer,
    fetchGranules: (signal, start, end) => fetchGranules({ collections: drawn.granules, start, end }, signal),
    outline: (granule) => ({ granule, primitive: outlinePrimitive(granule, OUTLINE_COLOR) }),
    ...(drawn.provider !== "cmr" && { pixels: gibsPixels(drawn, primitives) }),
    ...(follow !== undefined && { sensing: sensing(drawn, primitives, follow) }),
  };
  const outlines: GranuleOutlines<GranuleOutline> = {
    add: (outline) => {
      primitives.add(outline.primitive);
    },
    remove: (outline) => {
      primitives.remove(outline.primitive);
    },
  };
  return { source, outlines };
}
