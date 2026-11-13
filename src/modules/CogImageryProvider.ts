// Cesium has no Cloud Optimized GeoTIFF reader. This one reads a whole-world Web Mercator
// COG whose overviews are aligned to the tile grid (GDAL's `TILING_SCHEME=GoogleMapsCompatible`),
// so a Cesium tile is one tile of one TIFF image, read with one range request.

import { Event, type Rectangle } from "@cesium/core";
import { Credit, DiscardEmptyTileImagePolicy, type ImageryProvider, type ImageryTypes, type Request, Resource, WebMercatorTilingScheme } from "@cesium/engine";
import { type Source, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";

/** Metres; the half width of the Web Mercator square. */
const WORLD_HALF = 20037508.342789244;

/** A COG to read, and the credits it asks for, a line each. */
export interface CogFile {
  url: string;
  credits: string[];
}

/** What a `CogImageryProvider` reads. */
export interface CogOptions {
  file: Promise<CogFile>;
  /** Pixels; the COG's block size. */
  tileSize: number;
  /** The deepest level in `tileSize` tiles. */
  maximumLevel: number;
}

/** Reads `url` in ranges; refuses a whole-file answer, which for a COG can be hundreds of MB. */
export function rangeSource(url: string): Source {
  return {
    url: new URL(url),
    async fetch(offset, length, options) {
      const end = length === undefined ? "" : String(offset + length - 1);
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` }, signal: options?.signal });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`${url}: HTTP ${response.status} to a range request`);
      }
      return response.arrayBuffer();
    },
  };
}

/** An aligned level z of a COG: the image `tileSize`·2^z pixels square. */
interface Level {
  image: TiffImage;
  /** Byte offsets and counts of its tiles, x fastest; undefined until fetched. */
  tiles?: { offsets: ArrayLike<number>; counts: ArrayLike<number> };
  loading?: Promise<void>;
}

/** Whether `image` covers the Web Mercator square, with 1 m of slack for the writer's rounding. */
function coversWorld(image: TiffImage): boolean {
  const [west, south, east, north] = image.bbox;
  return [-west, -south, east, north].every((edge) => Math.abs(edge - WORLD_HALF) < 1);
}

/** The tag's values; a sparse file may list fewer than it has tiles, and the rest are empty. */
async function tagValues(image: TiffImage, tag: TiffTag.TileOffsets | TiffTag.TileByteCounts): Promise<ArrayLike<number>> {
  const values = await image.fetch(tag);
  return typeof values === "number" ? [values] : (values ?? []);
}

/** A whole-world Web Mercator COG as Cesium imagery, a Cesium tile to one block of one level. */
export class CogImageryProvider implements ImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle: Rectangle = this.tilingScheme.rectangle;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  /** A sparse tile comes back as its empty image, which this discards so the parent tile is drawn. */
  readonly tileDiscardPolicy = new DiscardEmptyTileImagePolicy();
  readonly errorEvent = new Event();
  readonly proxy = undefined as unknown as ImageryProvider["proxy"];
  readonly hasAlphaChannel = true;
  /** Undefined, which Cesium skips: its credits come with each tile, one a line. */
  readonly credit = undefined as unknown as Credit;

  /** Its aligned images by level, once the header is read. */
  #levels: Map<number, Level> | undefined;
  #failed = false;
  /** Empty until the file is known; no tile is asked for before then. */
  #credits: Credit[] = [];

  constructor(options: CogOptions) {
    this.tileWidth = options.tileSize;
    this.tileHeight = options.tileSize;
    this.maximumLevel = options.maximumLevel;
    this.#open(options.file);
  }

  /** Reads the header: which image is which level. */
  #open(file: Promise<CogFile>): void {
    void file
      .then(({ url, credits }) => {
        this.#credits = credits.map((line) => new Credit(line));
        return Tiff.create(rangeSource(url));
      })
      .then((tiff) => {
        if (!tiff.images[0] || tiff.images[0].epsg !== 3857 || !coversWorld(tiff.images[0])) {
          throw new Error(`${tiff.source.url.href}: not a whole-world Web Mercator COG`);
        }
        const levels = new Map<number, Level>();
        for (const image of tiff.images) {
          const level = Math.log2(image.size.width / this.tileWidth);
          if (Number.isInteger(level) && image.size.width === image.size.height && image.tileSize.width === this.tileWidth && image.tileSize.height === this.tileHeight) {
            levels.set(level, { image });
          }
        }
        this.#levels = levels;
      })
      .catch((error: unknown) => {
        this.#failed = true;
        console.warn("[CogImageryProvider]", error);
      });
  }

  /**
   * Fetches the level's tile index whole, so each tile after it is one request. A failed
   * read is asked for again by the next tile, as one lost request should not blank the frame.
   */
  #load(level: Level): void {
    level.loading ??= Promise.all([tagValues(level.image, TiffTag.TileOffsets), tagValues(level.image, TiffTag.TileByteCounts)])
      .then(([offsets, counts]) => {
        level.tiles = { offsets, counts };
      })
      .catch((error: unknown) => {
        level.loading = undefined;
        console.warn("[CogImageryProvider]", error);
      });
  }

  /** The file's credits, which Cesium shows while any of its tiles is drawn. */
  getTileCredits(): Credit[] {
    return this.#credits;
  }

  /**
   * Undefined, which Cesium takes as "ask again", while the header or the level's tile
   * index loads: Cesium renders while the globe has tiles left to load, so it asks soon.
   */
  requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    if (this.#failed) {
      return Promise.reject(new Error("COG unreadable"));
    }
    if (!this.#levels) {
      return undefined;
    }
    const found = this.#levels.get(level);
    if (!found) {
      return Promise.resolve(DiscardEmptyTileImagePolicy.EMPTY_IMAGE);
    }
    if (!found.tiles) {
      this.#load(found);
      return undefined;
    }
    const index = y * found.image.tileCount.x + x;
    const offset = found.tiles.offsets[index] ?? 0;
    const count = found.tiles.counts[index] ?? 0;
    if (offset === 0 || count === 0) {
      return Promise.resolve(DiscardEmptyTileImagePolicy.EMPTY_IMAGE);
    }
    const mimeType = found.image.compression ?? "application/octet-stream";
    const bytes = new Resource({
      url: found.image.tiff.source.url.href,
      headers: { Range: `bytes=${offset}-${offset + count - 1}` },
      request,
    }).fetchArrayBuffer();
    // Flipped, as Cesium's own imagery loading does: WebGL ignores UNPACK_FLIP_Y for an ImageBitmap.
    return bytes?.then((buffer) =>
      createImageBitmap(new Blob([buffer], { type: mimeType }), { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "default" }),
    );
  }

  /** Nothing to pick: the mosaic is a picture. */
  pickFeatures(): undefined {
    return undefined;
  }
}
