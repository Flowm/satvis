// A layer selection's wire form: a provider with an optional opacity, `ArcGis` or `ArcGis_0.5`.
// Cesium-free, for the url codec, the store and CesiumController.

export interface LayerSelection {
  provider: string;
  /** Absent means the provider's default opacity. */
  alpha?: number;
}

/** Undefined when the token is not a usable selection. The provider name is not checked here. */
export function parseLayer(token: string): LayerSelection | undefined {
  const separator = token.indexOf("_");
  if (separator === -1) {
    return token === "" ? undefined : { provider: token };
  }
  const provider = token.slice(0, separator);
  const rawAlpha = token.slice(separator + 1);
  if (provider === "" || rawAlpha === "") {
    return undefined;
  }
  const alpha = Number(rawAlpha);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    return undefined;
  }
  return { provider, alpha };
}

export function formatLayer(selection: LayerSelection): string {
  return selection.alpha === undefined ? selection.provider : `${selection.provider}_${selection.alpha}`;
}

/** Undefined if the token is unusable. */
export function layerProvider(token: string): string | undefined {
  return parseLayer(token)?.provider;
}
