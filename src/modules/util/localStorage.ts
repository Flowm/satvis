/** The browser's local storage, or none: private windows and blocked site data throw on access. */
export function localStorageOrNone(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}
