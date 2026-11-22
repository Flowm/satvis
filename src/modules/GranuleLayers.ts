// Granule layers on the globe (ADR 0023): CMR lists the granules and their outlines, and
// for a GIBS layer of one granule a frame, GIBS draws each one's pixels, transparent outside
// it, as a layer of its own. A EUMETView frame is a swath an orbit, so each granule is its
// fill, a picture cut to the outline, kept once passed. A `cmr` layer has the outlines
// alone. Where its satellite is drawn, the granule under it fills in behind its scan line,
// the ground track fan's.

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
  SceneMode,
  type TileProviderError,
} from "@cesium/engine";

import { type GranuleLayer, granulePictureUrl, type TiledImagery } from "@/config/instrumentImagery";
import { hasPixels } from "@/modules/overpassReplay";
import { fetchGranules, type Granule, granuleExtent } from "@/modules/util/cmrGranules";

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

/** An outline with pixels inside it, or of a layer of outlines alone. */
const OUTLINE_COLOR = Color.fromCssColorString("#ffd54a").withAlpha(0.9);
/** An outline whose granule the provider has no pixels of. */
const MISSING_COLOR = Color.fromCssColorString("#9e9e9e").withAlpha(0.7);

/** A fill with no picture, of outlines alone or before its picture comes: the outlines' colour, faint, yet seen over land. */
const FILL_TINT = Color.fromCssColorString("#ffd54a").withAlpha(0.35);

/** A fill whose picture the provider does not have: grey, as its outline will be once passed. */
const MISSING_FILL_TINT = MISSING_COLOR.withAlpha(0.35);

/** Pixels. */
const OUTLINE_WIDTH = 2;

/** Times a tile GIBS failed to send is asked for again. */
const TILE_RETRIES = 2;

/** Pixels across a granule's picture while it fills: 577 KB for a NOAA 20 granule as JPEG, 5 MB as PNG (measured 2026-11-21). */
const PICTURE_WIDTH = 2048;

/**
 * Pixels across the picture of a granule that keeps it once passed, a EUMETView one: 1.2 km
 * a pixel across OLCI's 1,270 km. A trail of 17 granules is 56 MB of textures, where at
 * PICTURE_WIDTH it would be 220 MB, past what an iPad mini can spare.
 */
const KEPT_PICTURE_WIDTH = 1024;

/** Degrees of longitude past which a granule, near a pole, gets no picture while it fills: a plate carrée one would be mostly stretch. */
const PICTURE_MAX_SPAN = 90;

/** Degrees padded around a granule's picture, so its edge is never sampled at the outline. */
const PICTURE_MARGIN = 0.5;

/** WGS84's 1 - e², from geocentric to geodetic latitude on the surface. */
const POLAR_RATIO_SQUARED = (Ellipsoid.WGS84.radii.z / Ellipsoid.WGS84.radii.x) ** 2;

/**
 * Discards what lies ahead of the scan line until the granule is passed. Behind it, the
 * tint until the picture has come, then the picture, sampled by latitude and longitude and
 * shaded as the globe shades its tiles, so the fill looks as the granule will once passed:
 * unshaded, a granule over Siberia at noon in November read 30% brighter than its tiles.
 */
const FILL_SHADER = `
// The globe's own shading of imagery (GlobeFS.glsl, @cesium/engine 26.5), so a granule
// filling in looks as its tiles will once it has passed: linear colour under HDR, the
// sun's diffuse light, and the ground atmosphere computed per fragment. The globe's
// settings come as uniforms, as its defines do not reach a primitive.
vec3 globeShaded(vec3 colour, vec3 world) {
  colour = czm_gammaCorrect(colour);
  float cameraDistance = length(czm_view[3]);
  float fade = clamp((cameraDistance - fadeDistances.x) / (fadeDistances.y - fadeDistances.x), 0.0, 1.0);
  vec3 normalEC = czm_normal3D * czm_geodeticSurfaceNormal(world, vec3(0.0), vec3(1.0));
  bool lighting = shading.x > 0.5;
  if (lighting && vertexLighting.x > 0.5) {
    colour *= czm_lightColor * clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * vertexLighting.y + vertexLighting.z, 0.0, 1.0);
  } else if (lighting) {
    float diffuse = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
    colour *= czm_lightColor * mix(1.0, diffuse, fade);
  }
  if (shading.y > 0.5) {
    bool dynamicLighting = lighting && shading.z > 0.5;
    vec3 light = shading.w > 0.5 ? czm_sunDirectionWC : czm_lightDirectionWC;
    vec3 lightDirection = dynamicLighting ? light : normalize(world);
    vec3 rayleigh;
    vec3 mie;
    float opacity;
    czm_computeGroundAtmosphereScattering(world, lightDirection, rayleigh, mie, opacity);
    vec4 atmosphere = czm_computeAtmosphereColor(world, lightDirection, rayleigh, mie, opacity);
    vec3 hazed = colour + atmosphere.rgb * (0.5 + clamp(1.0 - atmosphere.a, 0.0, 1.0));
    if (dynamicLighting) {
      // GlobeFS's own reading: from the night fade-in distance out to the fade-out one.
      float sunlit = clamp((cameraDistance - fadeDistances.w) / (fadeDistances.z - fadeDistances.w), 0.05, 1.0);
      float darken = clamp(dot(normalize(world), light), 0.0, 1.0);
      hazed = mix(mix(atmosphere.rgb, hazed, darken), hazed, sunlit);
    }
#ifdef HDR
    hazed = czm_saturation(hazed, 1.6);
#else
    hazed = vec3(1.0) - exp(-2.0 * hazed);
#endif
    colour = mix(colour, hazed, fade);
  }
  return colour;
}

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
  // Outside 3D the depth gives projected coordinates, not the Earth-fixed ones the picture is sampled by.
  if (picture > 0.5 && czm_sceneMode == czm_sceneMode3D) {
    float longitude = atan(world.y, world.x);
    if (longitude < bounds.x) {
      longitude += czm_twoPi;
    }
    float latitude = atan(world.z, ${POLAR_RATIO_SQUARED.toFixed(9)} * length(world.xy));
    vec4 texel = texture(image, (vec2(longitude, latitude) - bounds.xy) / (bounds.zw - bounds.xy));
    // The JPEG's black is where the granule has no pixels: clear, as its tile layer leaves it.
    if (max(texel.r, max(texel.g, texel.b)) <= 0.02) {
      discard;
    }
    colour = vec4(globeShaded(texel.rgb, world), 1.0);
  }
  material.diffuse = colour.rgb;
  material.alpha = colour.a;
  return material;
}
`;

/**
 * The globe's shading settings as the fill shader's uniforms: whether it lights imagery,
 * hazes it with the ground atmosphere (in 3D only), lights the atmosphere by the sun and
 * from it; its terrain's vertex lighting; its lighting and night fade distances.
 */
function globeShading(scene: Scene, shading: Cartesian4, vertexLighting: Cartesian3, fadeDistances: Cartesian4): void {
  const { globe } = scene;
  shading.x = globe.enableLighting ? 1 : 0;
  shading.y = globe.showGroundAtmosphere && scene.mode === SceneMode.SCENE3D ? 1 : 0;
  shading.z = globe.dynamicAtmosphereLighting ? 1 : 0;
  shading.w = globe.dynamicAtmosphereLightingFromSun ? 1 : 0;
  vertexLighting.x = globe.terrainProvider.hasVertexNormals ? 1 : 0;
  vertexLighting.y = globe.lambertDiffuseMultiplier;
  vertexLighting.z = globe.vertexShadowDarkness;
  fadeDistances.x = globe.lightingFadeOutDistance;
  fadeDistances.y = globe.lightingFadeInDistance;
  fadeDistances.z = globe.nightFadeOutDistance;
  fadeDistances.w = globe.nightFadeInDistance;
}

/** A granule's outline, drawn on the ground in `color`. */
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

/**
 * The provider's pixels of the granules of `drawn`: for GIBS, a layer of one granule a frame,
 * a tile layer each; for EUMETView, whose frame is a swath an orbit, the fills alone.
 */
function providerPixels(drawn: GranuleLayer & TiledImagery, primitives: PrimitiveCollection): GranulePixels<ImageryLayer, GranuleOutline> {
  const markMissing = (outline: GranuleOutline) => {
    if (primitives.contains(outline.primitive)) {
      primitives.remove(outline.primitive);
      outline.primitive = primitives.add(outlinePrimitive(outline.granule, MISSING_COLOR)) as GroundPolylinePrimitive;
    }
  };
  if (drawn.provider !== "gibs") {
    return { has: (granule) => hasPixels(drawn, granule), markMissing };
  }
  const options = { layer: drawn.layer, maximumLevel: drawn.maxLevel, format: drawn.format, daily: false };
  const frames = gibsFrames(options);
  return {
    has: (granule) => gibsHasGranule(options, granule.start),
    markMissing,
    layer: (granule) => {
      const provider = frames.show(granule.start);
      // GIBS answers some of the tiles of several granules asked for at once with a 500
      // that a second request gets (measured 2026-11-21: 7 of 461).
      provider.errorEvent.addEventListener((error: TileProviderError) => {
        error.retry = error.timesRetried < TILE_RETRIES;
      });
      return { layer: new ImageryLayer(provider), loaded: trackRequests(provider) };
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

/** The granule's picture in its fill, where the provider has its pixels and it is not near a pole; grey where it has none. */
async function loadPicture(drawn: GranuleLayer & TiledImagery, granule: Granule, fill: GranuleFill): Promise<void> {
  const has = await hasPixels(drawn, granule);
  if (fill.gone) {
    return;
  }
  if (!has) {
    fill.material.uniforms.tint = MISSING_FILL_TINT;
    return;
  }
  const extent = granuleExtent(granule);
  const span = extent.east - extent.west;
  // GIBS's WMS draws nothing for a box across the antimeridian. EUMETView's draws one that
  // runs past 180° east, which the shader samples by adding a turn to the longitudes west of it.
  const across = extent.west < -180 || extent.east > 180;
  const eumetview = drawn.provider === "eumetview";
  if (span > PICTURE_MAX_SPAN || (across && !eumetview)) {
    return;
  }
  const west = extent.west < -180 ? extent.west + 360 : extent.west;
  const bounds = {
    west: Math.max(-180, west - PICTURE_MARGIN),
    south: Math.max(-90, extent.south - PICTURE_MARGIN),
    east: Math.min(eumetview ? 360 : 180, west + span + PICTURE_MARGIN),
    north: Math.min(90, extent.north + PICTURE_MARGIN),
  };
  const width = eumetview ? KEPT_PICTURE_WIDTH : PICTURE_WIDTH;
  const height = Math.round((width * (bounds.north - bounds.south)) / (bounds.east - bounds.west));
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = granulePictureUrl(drawn, granule.start, bounds, width, Math.min(width, Math.max(1, height)));
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
  // Every granule asks for the scan line each tick, so it is computed once a time. A missing
  // one is not kept: the satellite's samples of a time the clock jumped to come later.
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

  const shading = new Cartesian4();
  const vertexLighting = new Cartesian3();
  const fadeDistances = new Cartesian4();
  const removeListener = follow.scene.preRender.addEventListener(() => {
    globeShading(follow.scene, shading, vertexLighting, fadeDistances);
    const plane = scanFor(JulianDate.toDate(follow.clock.currentTime).getTime());
    for (const { material } of fills) {
      material.uniforms.shading = shading;
      material.uniforms.vertexLighting = vertexLighting;
      material.uniforms.fadeDistances = fadeDistances;
      if (plane !== undefined) {
        material.uniforms.scanPoint = plane.point;
        material.uniforms.scanAhead = plane.ahead;
      }
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
            shading: new Cartesian4(),
            vertexLighting: new Cartesian3(),
            fadeDistances: new Cartesian4(),
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
      // A primitive leaves its appearance's material, and the picture's texture with it.
      fill.material.destroy();
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
    ...(drawn.provider !== "cmr" && { pixels: providerPixels(drawn, primitives) }),
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
