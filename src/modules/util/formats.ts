// Numbers and dates as people read them, in the browser's region (ADR 0015). What is
// not for people, url parameters, stored values and analytics, keeps its fixed form, and
// a date in figures alone is ISO 8601 in every region.

/**
 * English words in the conventions of the region the browser's first language names:
 * "en-DE" for German, as iOS gives an English-only app on a German device. The language
 * itself would put German month names into an English interface. A language with no
 * region gets its likeliest one, so "de" is "en-DE" and "en" is "en-US".
 */
export function localeFor(languages: readonly string[]): string {
  try {
    const region = new Intl.Locale(languages[0] ?? "en-US").maximize().region;
    return region === undefined ? "en-US" : `en-${region}`;
  } catch {
    // A malformed tag throws.
    return "en-US";
  }
}

/** Replaced by `setFormatLocale`; outside a browser, en-US. */
let locale = localeFor(globalThis.navigator?.languages ?? []);

/** Formatters by locale and options: building one costs far more than using it. */
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

/** Pins the locale, for tests and the parity fixtures. */
export function setFormatLocale(tag: string): void {
  locale = tag;
  cache.clear();
}

/** The formatter `make` builds for the current locale and `options`, built once. */
function cached<Format extends Intl.NumberFormat | Intl.DateTimeFormat>(kind: string, options: object, make: () => Format): Format {
  const key = `${kind}${locale}${JSON.stringify(options)}`;
  let format = cache.get(key) as Format | undefined;
  if (format === undefined) {
    format = make();
    cache.set(key, format);
  }
  return format;
}

/** A number formatter for the current locale. */
const numberFormat = (options: Intl.NumberFormatOptions): Intl.NumberFormat => cached("n", options, () => new Intl.NumberFormat(locale, options));

/** A date formatter for the current locale, in UTC. */
const dateFormat = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => cached("d", options, () => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }));

/** "16,819" or "16.819": rounded to a whole number. */
export const formatInteger = (value: number): string => numberFormat({ maximumFractionDigits: 0 }).format(value);

/** "2,857.123": up to three decimals, the rest rounded half away from zero, as `toLocaleString` writes a number. */
export const formatMeasure = (value: number): string => numberFormat({ maximumFractionDigits: 3 }).format(value);

/**
 * `value.toFixed(digits)` with the region's separators: "1,234.50" or "1.234,50". It
 * rounds as `toFixed` does, which the native app's port matches to the digit; `Intl`
 * rounds the shortest decimal instead, so 1.005 would part ways.
 */
export const formatFixed = (value: number, digits: number): string => formatDecimal(value.toFixed(digits));

/**
 * A decimal written out as `String(number)` or `toFixed` writes it, every digit kept, in
 * the region's separators: "12.6" is "12,6" in Germany. `Intl` reads a string exactly.
 */
export function formatDecimal(text: string): string {
  const fraction = /\.(\d+)$/.exec(text)?.[1]?.length ?? 0;
  // A string the format cannot read, "NaN" say, comes back as it is.
  return /^-?\d+(\.\d+)?$/.test(text) ? numberFormat({ minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(text as Intl.StringNumericLiteral) : text;
}

/** "48.14°, 11.58°": a place to two decimals, as a station without a name is shown. */
export const formatCoordinates = (latitude: number, longitude: number): string => `${formatFixed(latitude, 2)}°, ${formatFixed(longitude, 2)}°`;

/** A number as `String(value)` writes it, every digit kept, in the region's separators. */
export const formatNumber = (value: number): string => formatDecimal(String(value));

/** "Sun, Oct 25" or "Sun, 25 Oct": the clock deck's day, in UTC. */
export const formatWeekdayDate = (date: Date | number): string => dateFormat({ weekday: "short", day: "2-digit", month: "short" }).format(date);
