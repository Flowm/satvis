// Granule layers on the globe (ADR 0023): CMR lists the granules and their outlines, and
// for a GIBS layer of one granule a frame, GIBS draws each one's pixels, transparent outside
// it, as a layer of its own. A `cmr` layer has the outlines alone.

import { Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance } from "@cesium/core";
import { GroundPolylineGeometry, GroundPolylinePrimitive, ImageryLayer, PolylineColorAppearance, type PrimitiveCollection, type TileProviderError } from "@cesium/engine";

import type { GranuleLayer, TiledImagery } from "@/config/instrumentImagery";
import { fetchGranules, type Granule } from "@/modules/util/cmrGranules";

import { gibsFrames, gibsHasGranule } from "./GibsImagery";
import type { GranuleOutlines, GranulePixels, GranuleSource } from "./GranuleImagery";

/** A granule's outline on the ground; its primitive is replaced when it is marked missing. */
export interface GranuleOutline {
  granule: Granule;
  primitive: GroundPolylinePrimitive;
}

/** An outline with pixels inside it, or of a layer of outlines alone, and one whose pixels the provider does not have. */
const OUTLINE_COLOR = Color.fromCssColorString("#ffd54a").withAlpha(0.9);
const MISSING_COLOR = Color.fromCssColorString("#9e9e9e").withAlpha(0.7);

/** Pixels. */
const OUTLINE_WIDTH = 2;

/** Times a tile GIBS failed to send is asked for again. */
const TILE_RETRIES = 2;

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
      return new ImageryLayer(provider);
    },
    markMissing: (outline) => {
      if (primitives.contains(outline.primitive)) {
        primitives.remove(outline.primitive);
        outline.primitive = primitives.add(outlinePrimitive(outline.granule, MISSING_COLOR)) as GroundPolylinePrimitive;
      }
    },
  };
}

/** The services behind `drawn`, a layer with CMR collections, and where its outlines go. */
export function granuleLayer(
  drawn: GranuleLayer,
  primitives: PrimitiveCollection,
): { source: GranuleSource<ImageryLayer, GranuleOutline>; outlines: GranuleOutlines<GranuleOutline> } {
  const source: GranuleSource<ImageryLayer, GranuleOutline> = {
    name: drawn.layer,
    fetchGranules: (signal, start, end) => fetchGranules({ collections: drawn.granules, start, end }, signal),
    outline: (granule) => ({ granule, primitive: outlinePrimitive(granule, OUTLINE_COLOR) }),
    ...(drawn.provider !== "cmr" && { pixels: gibsPixels(drawn, primitives) }),
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
