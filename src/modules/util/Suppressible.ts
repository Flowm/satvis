// A setting the user owns that something else can temporarily take over (see
// suppression in CONTEXT.md). Cesium-free: enacting the value is the caller's job.

/**
 * `isCurrent` turns false once a newer apply starts. An async apply checks it
 * after each await, so a late one cannot overwrite a newer one.
 */
export type Apply<T> = (value: T, isCurrent: () => boolean) => void | Promise<void>;

/** Suppressing never writes `chosen`, so the toolbar and the url keep the user's choice. */
export class Suppressible<T> {
  #chosen: T;

  #override: T | undefined;

  #apply: Apply<T>;

  #generation = 0;

  /** No apply on construction: the initial value is already in force. */
  constructor(initial: T, apply: Apply<T>) {
    this.#chosen = initial;
    this.#apply = apply;
  }

  /** What the user picked, whether or not it is being honoured. */
  get chosen(): T {
    return this.#chosen;
  }

  get inForce(): T {
    return this.#override ?? this.#chosen;
  }

  get suppressed(): boolean {
    return this.#override !== undefined;
  }

  /**
   * Applied only if it is in force; a choice made under a suppression waits for release.
   *
   * @returns whether this changed what is in force.
   */
  choose(value: T): boolean {
    if (Object.is(value, this.#chosen)) {
      return false;
    }
    const before = this.inForce;
    this.#chosen = value;
    return this.#reapply(before);
  }

  /** @returns whether this changed what is in force. */
  suppress(value: T): boolean {
    if (Object.is(value, this.#override)) {
      return false;
    }
    const before = this.inForce;
    this.#override = value;
    return this.#reapply(before);
  }

  /** @returns whether this changed what is in force. */
  release(): boolean {
    if (this.#override === undefined) {
      return false;
    }
    const before = this.inForce;
    this.#override = undefined;
    return this.#reapply(before);
  }

  #reapply(before: T): boolean {
    const value = this.inForce;
    if (Object.is(value, before)) {
      return false;
    }
    const generation = ++this.#generation;
    void this.#apply(value, () => generation === this.#generation);
    return true;
  }
}

export interface SetChange {
  show: string[];
  hide: string[];
}

/**
 * `Suppressible` for a set whose members are suppressed one by one. It remembers
 * what it last put in force, so `apply` receives only the difference.
 */
export class SuppressibleSet {
  #chosen: readonly string[] = [];

  #suppressed = new Set<string>();

  #inForce = new Set<string>();

  #apply: (change: SetChange) => void;

  constructor(apply: (change: SetChange) => void) {
    this.#apply = apply;
  }

  get chosen(): readonly string[] {
    return this.#chosen;
  }

  get inForce(): string[] {
    return [...this.#inForce];
  }

  isSuppressed(name: string): boolean {
    return this.#suppressed.has(name);
  }

  choose(values: readonly string[]): void {
    this.#chosen = [...values];
    this.#settle();
  }

  /** @returns false when `name` is already suppressed or not chosen. */
  suppress(name: string): boolean {
    if (this.#suppressed.has(name) || !this.#chosen.includes(name)) {
      return false;
    }
    this.#suppressed.add(name);
    this.#settle();
    return true;
  }

  /** @returns whether this brought anything back. */
  release(name: string): boolean {
    if (!this.#suppressed.delete(name)) {
      return false;
    }
    return this.#settle().show.length > 0;
  }

  #settle(): SetChange {
    const next = new Set(this.#chosen.filter((name) => !this.#suppressed.has(name)));
    const show = [...next].filter((name) => !this.#inForce.has(name));
    const hide = [...this.#inForce].filter((name) => !next.has(name));
    this.#inForce = next;
    if (show.length > 0 || hide.length > 0) {
      this.#apply({ show, hide });
    }
    return { show, hide };
  }
}
