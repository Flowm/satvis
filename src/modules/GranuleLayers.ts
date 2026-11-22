// Granule layers on the globe (ADR 0023): a catalogue, CMR or EUMETSAT's Data Store, lists
// the granules and their outlines, and for a GIBS layer of one granule a frame, GIBS draws
// each one's pixels, transparent outside it, as a layer of its own. Any other layer's frame
// holds more than a granule (a swath, six orbits, a day), so each granule is its fill, a
// picture cut to the outline, kept once passed. A layer without pictures has the outlines
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
  Math as CesiumMath,
  JulianDate,
  PolygonGeometry,
  PolygonHierarchy,
  Rectangle,
} from "@cesium/core";
import {
  Credit,
  type CreditDisplay,
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

import { type GranuleLayer, type GranulePictures, granulePictureUrl, type PreviewBounds } from "@/config/instrumentImagery";
import { catalogueQuery, granuleCentre, hasPixels } from "@/modules/overpassReplay";
import { fetchGranules, type Granule, granuleExtent } from "@/modules/util/cmrGranules";

import { eumetViewCredit } from "./EumetViewImagery";
import { trackRequests } from "./FramedImagery";
import { GIBS_CREDIT, gibsFrames, gibsHasGranule } from "./GibsImagery";
import type { GranuleOutlines, GranulePixels, GranuleSensing, GranuleSource } from "./GranuleImagery";
import { PICTURE_TRIES } from "./granulePictures";
import type { ScanPlane } from "./satelliteGraphics";

/** A granule's outline on the ground; its primitive is replaced when it is marked missing. */
interface GranuleOutline {
  granule: Granule;
  primitive: GroundPolylinePrimitive;
}

/** A granule filling in behind the scan line. */
interface GranuleFill {
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
 * Pixels across the picture of a granule that keeps it once passed, at most: 1.2 km a pixel
 * across OLCI's 1,270 km. A trail of 17 granules is 56 MB of textures, where at
 * PICTURE_WIDTH it would be 220 MB, past what an iPad mini can spare.
 */
const KEPT_PICTURE_WIDTH = 1024;

/**
 * Pixels a degree of a kept picture, at most: 430 m a pixel. An HLS scene is 1.4° across,
 * and a trail of Landsat 9's has 60 of them: 32 MB of textures at this, 250 MB at 1,024.
 */
const KEPT_PIXELS_PER_DEGREE = 256;

/** Pixels across a kept picture, at least, so a small granule near the camera is not a blur. */
const KEPT_PICTURE_MIN_WIDTH = 256;

/**
 * Degrees from the equator past which a granule cut from a daily layer gets no picture:
 * there its day's later passes overlap it, and the day's picture holds one of them.
 */
const DAILY_MAX_LATITUDE = 60;

/** Degrees of longitude past which a granule, near a pole, gets no picture while it fills: a plate carrée one would be mostly stretch. */
const PICTURE_MAX_SPAN = 90;

/** Degrees padded around a granule's picture, so its edge is never sampled at the outline. */
const PICTURE_MARGIN = 0.5;

/** Degrees padded around a granule's tile layer, for a scan line that is not quite a great circle. */
const LAYER_MARGIN = 1;

/** Degrees of latitude past which a granule's tile layer covers the globe: its box might miss a pole it covers. */
const LAYER_MAX_LATITUDE = 80;

/**
 * Points taken along each edge of a granule for its tile layer's box. Between two corners at 70°,
 * a 2,800 km edge, a VIIRS scan line's, bows 4.3° toward the pole, past their box.
 */
const EDGE_STEPS = 16;

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
 * The pixels of the granules of `drawn`: for a GIBS layer of one granule a frame, a tile
 * layer each; for one whose frames hold more than a granule, the fills alone.
 */
function providerPixels(drawn: GranuleLayer, primitives: PrimitiveCollection): GranulePixels<ImageryLayer, GranuleOutline> {
  const markMissing = (outline: GranuleOutline) => {
    if (primitives.contains(outline.primitive)) {
      primitives.remove(outline.primitive);
      outline.primitive = primitives.add(outlinePrimitive(outline.granule, MISSING_COLOR)) as GroundPolylinePrimitive;
    }
  };
  if (drawn.provider !== "gibs" || drawn.pictures?.frame !== "granule") {
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
      return { layer: new ImageryLayer(provider, { rectangle: layerRectangle(granule) }), loaded: trackRequests(provider) };
    },
  };
}

/**
 * Where a granule's tile layer asks for tiles and is drawn: its box. Without one, each granule of
 * a trail asked for a tile wherever the globe had one, nearly all transparent, and every globe tile
 * sampled each. Undefined, the whole globe, for one across the antimeridian or near a pole.
 */
export function layerRectangle(granule: Granule): Rectangle | undefined {
  const corners = granule.outline.map(({ latitude, longitude }) => Cartesian3.fromDegrees(longitude, latitude, 0, Ellipsoid.UNIT_SPHERE));
  const along = new Cartesian3();
  const edges = corners.flatMap((corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    return Array.from({ length: EDGE_STEPS }, (_, step) => {
      Cartesian3.normalize(Cartesian3.lerp(corner, next, step / EDGE_STEPS, along), along);
      return { latitude: CesiumMath.toDegrees(Math.asin(along.z)), longitude: CesiumMath.toDegrees(Math.atan2(along.y, along.x)) };
    });
  });
  const { west, south, east, north } = granuleExtent({ outline: edges });
  if (west - LAYER_MARGIN < -180 || east + LAYER_MARGIN > 180 || north > LAYER_MAX_LATITUDE || south < -LAYER_MAX_LATITUDE) {
    return undefined;
  }
  return Rectangle.fromDegrees(west - LAYER_MARGIN, south - LAYER_MARGIN, east + LAYER_MARGIN, north + LAYER_MARGIN);
}

/** Where the satellite a granule layer belongs to scans at a time, while it is drawn. */
interface GranuleFollow {
  scan: (time: JulianDate) => ScanPlane | undefined;
  clock: Clock;
  scene: Scene;
  /** Where the pictures in its fills are credited. */
  credits: CreditDisplay;
  /** Ends the following. */
  signal: AbortSignal;
}

/**
 * The granule's picture in its fill, where the provider has its pixels and it is not near a
 * pole; grey where it has none. Each asks `scene` for its frames, which a paused clock draws none of.
 */
async function loadPicture(drawn: GranuleLayer, pictures: GranulePictures, granule: Granule, fill: GranuleFill, scene: Pick<Scene, "requestRender" | "postRender">): Promise<void> {
  const has = await hasPixels(drawn, granule);
  if (fill.gone) {
    return;
  }
  if (!has) {
    fill.material.uniforms.tint = MISSING_FILL_TINT;
    scene.requestRender();
    return;
  }
  const extent = granuleExtent(granule);
  const span = extent.east - extent.west;
  const polar = pictures.frame === "day" && Math.abs(granuleCentre(granule).latitude) > DAILY_MAX_LATITUDE;
  if (span > PICTURE_MAX_SPAN || polar) {
    return;
  }
  // A box across the antimeridian runs past 180° east, which the shader samples by adding a
  // turn to the longitudes west of it.
  const west = extent.west < -180 ? extent.west + 360 : extent.west;
  const bounds = {
    west: Math.max(-180, west - PICTURE_MARGIN),
    south: Math.max(-90, extent.south - PICTURE_MARGIN),
    east: Math.min(360, west + span + PICTURE_MARGIN),
    north: Math.min(90, extent.north + PICTURE_MARGIN),
  };
  const kept = pictures.frame !== "granule";
  const width = kept ? Math.min(KEPT_PICTURE_WIDTH, Math.max(KEPT_PICTURE_MIN_WIDTH, Math.round((bounds.east - bounds.west) * KEPT_PIXELS_PER_DEGREE))) : PICTURE_WIDTH;
  const height = Math.min(width, Math.max(1, Math.round((width * (bounds.north - bounds.south)) / (bounds.east - bounds.west))));
  const image =
    bounds.east > 180 && pictures.provider === "gibs"
      ? await joinedPicture(pictures, granule.start, bounds, width, height)
      : await decodePicture(granulePictureUrl(pictures, granule.start, bounds, width, height));
  if (image === undefined || fill.gone) {
    return;
  }
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  fill.material.uniforms.bounds = new Cartesian4(radians(bounds.west), radians(bounds.south), radians(bounds.east), radians(bounds.north));
  fill.material.uniforms.image = image;
  // Cesium makes an image's texture in the frame after the one that takes it, and samples its
  // white default until then: drawn at once, the fill flashed white for a paced frame.
  const removeListener = scene.postRender.addEventListener(() => {
    removeListener();
    if (!fill.gone) {
      fill.material.uniforms.picture = 1;
      scene.requestRender();
    }
  });
  scene.requestRender();
}

/** The picture at `url`, asked for again where the service answers with an error; undefined where each try failed. */
async function decodePicture(url: string, tries = PICTURE_TRIES): Promise<HTMLImageElement | undefined> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  try {
    await image.decode();
    return image;
  } catch {
    return tries > 1 ? decodePicture(url, tries - 1) : undefined;
  }
}

/**
 * The picture of a box that runs past 180° east, from its two sides: GIBS's WMS draws
 * nothing for a box across the antimeridian, where EUMETView's draws one past it.
 */
async function joinedPicture(pictures: GranulePictures, start: number, bounds: PreviewBounds, width: number, height: number): Promise<HTMLCanvasElement | undefined> {
  const westWidth = Math.max(1, Math.round((width * (180 - bounds.west)) / (bounds.east - bounds.west)));
  const [west, east] = await Promise.all([
    decodePicture(granulePictureUrl(pictures, start, { ...bounds, east: 180 }, westWidth, height)),
    decodePicture(granulePictureUrl(pictures, start, { ...bounds, west: -180, east: bounds.east - 360 }, Math.max(1, width - westWidth), height)),
  ]);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (west === undefined || east === undefined || context === null) {
    return undefined;
  }
  canvas.width = west.width + east.width;
  canvas.height = height;
  context.drawImage(west, 0, 0);
  context.drawImage(east, west.width, 0);
  return canvas;
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
  // A picture in a fill is no tile of an imagery layer, so it brings no credit of its own.
  // Cesium clears the frame's credits after preRender.
  const creditsByText = new Map<string, Credit>();
  const removeCredit = follow.scene.postRender.addEventListener(() => {
    const pictures = drawn.pictures;
    if (pictures === undefined || ![...fills].some(({ material }) => material.uniforms.picture === 1)) {
      return;
    }
    const year = JulianDate.toDate(follow.clock.currentTime).getUTCFullYear();
    const text = pictures.provider === "gibs" ? GIBS_CREDIT : eumetViewCredit(pictures.layer, year);
    let credit = creditsByText.get(text);
    if (credit === undefined) {
      credit = new Credit(text);
      creditsByText.set(text, credit);
    }
    follow.credits.addCreditToNextFrame(credit);
  });
  follow.signal.addEventListener("abort", removeListener, { once: true });
  follow.signal.addEventListener("abort", removeCredit, { once: true });

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
      if (drawn.pictures !== undefined) {
        void loadPicture(drawn, drawn.pictures, granule, fill, follow.scene);
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
    fetchGranules: (signal, start, end) => fetchGranules({ ...catalogueQuery(drawn), start, end }, signal),
    outline: (granule) => ({ granule, primitive: outlinePrimitive(granule, OUTLINE_COLOR) }),
    ...(drawn.pictures !== undefined && { pixels: providerPixels(drawn, primitives) }),
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
