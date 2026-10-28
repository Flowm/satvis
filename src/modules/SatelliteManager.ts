import { Cartesian3, JulianDate } from "@cesium/core";
import { SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { ElementsEntry } from "../config/presets";
import type { SerializedGroundStation } from "../stores/sat";
import { ORBIT_LINE_COLOR, ORBIT_TRACK_LINE_COLOR } from "./componentKinds";
import { CUSTOM_KEY_PREFIX, CUSTOM_TAG, isCustom } from "./customSatellites";
import { GroundStationEntity, type GroundStationPositionData } from "./GroundStationEntity";
import { type Pass, stationPasses, stationPassesSettled } from "./PassPredictor";
import { RecutSchedule } from "./recutSchedule";
import { activeTargetEntries, buildOrder } from "./satelliteActivation";
import { type CatalogEntry, SatelliteCatalog } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { cancelPendingTrack, returnAfterTracking } from "./trackFlight";
import { CesiumCleanupHelper } from "./util/CesiumCleanupHelper";
import { sameValue } from "./util/equality";
import { approximatePeriodMinutes, type GpRecord } from "./util/gp";
import { GroundTrackBatch } from "./util/GroundTrackBatch";
import { type PassSource, WorkerPassSource } from "./util/passSource";
import { PolylineBatch } from "./util/PolylineBatch";
import { type SampleChunk, type SampleSource, WorkerSampleSource } from "./util/sampleSource";
import { SuppressibleSet } from "./util/Suppressible";
import { WINDOW_ORBITS_BACK, WINDOW_ORBITS_FORWARD } from "./util/trajectoryWindow";

/**
 * How long one frame may spend instantiating satellites. Measured at 5,000
 * satellites, worst frame gap / total build time in ms:
 *
 *      budget   Point        + Label      + Orbit       + Orbit track
 *      none     908 / 982    950 / 1216   1617 / 1678   951 / 1013
 *       8 ms     58 / 1998    92 / 4656     82 / 4067    83 / 2567
 *      16 ms     41 / 1477    91 / 2956     82 / 2822    73 / 1711
 *      32 ms     50 / 1241   100 / 2094    125 / 2421    51 / 1313
 *
 * The worst frame is the budget plus the render, and rendering 5,000 labelled
 * satellites alone takes 40 ms.
 */
const BUILD_BUDGET_MS = 16;

export interface DesiredScene {
  enabledTags: string[];
  enabledSatellites: string[];
  disabledSatellites: string[];
  components: string[];
  groundStations: SerializedGroundStation[];
  overpassMode: string;
  trackedSatellite: string;
}

export const EMPTY_SCENE: DesiredScene = {
  enabledTags: [],
  enabledSatellites: [],
  disabledSatellites: [],
  components: [],
  groundStations: [],
  overpassMode: "elevation",
  trackedSatellite: "",
};

export class SatelliteManager {
  /** The last scene handed to reconcile. Nothing else mirrors store state. */
  #desired: DesiredScene = EMPTY_SCENE;

  /** The user's choice comes from the desired scene; a scene morph suppresses Orbit. */
  #components = new SuppressibleSet(({ show, hide }) => {
    show.forEach((name) => this.#showComponent(name));
    hide.forEach((name) => this.#hideComponent(name));
  });

  #stations: GroundStationEntity[] = [];

  #onTrackedChange: ((name: string) => void) | undefined;

  viewer: Viewer;

  readonly catalog = new SatelliteCatalog();

  /** The shared primitive every untracked orbit is drawn into. */
  readonly orbits: PolylineBatch;

  /** The same for the Orbit track, which is Earth-fixed and needs its own model matrix. */
  readonly tracks: PolylineBatch;

  /** Every ground track, clipped to the clock in its shader. */
  readonly groundTracks: GroundTrackBatch;

  /** Keyed by catalog entry key. Only entries in the activation target have a collection. */
  #active = new Map<string, SatelliteComponentCollection>();

  pendingTrackedSatellite: string | undefined;

  /** Selected the moment it is built. See select(). */
  #pendingSelection: string | undefined;

  readonly #recuts: RecutSchedule;

  readonly #samples: SampleSource;

  readonly #passes: PassSource;

  /**
   * Satellites whose opening window has arrived. A satellite is only created once it has a position.
   */
  #ready: Array<{ key: string; entry: CatalogEntry; chunk: SampleChunk }> = [];

  /** Opening windows still in flight. */
  #opening = 0;

  /** Catalog entries waiting to be instantiated, in build order. */
  #queue: [string, CatalogEntry][] = [];

  #buildHandle: number | undefined;

  #buildWaiters: Array<() => void> = [];

  /** A satellite being rebuilt while tracked, whose track is not reported lost. */
  #retracking: string | undefined;

  /** Custom records' `#propagationKey`s. */
  #propagationKeys = new WeakMap<GpRecord, string>();

  /** Custom records keyed so far, so no key is handed out twice. */
  #customRecordCount = 0;

  /** The sources default to the workers; a test passes the inline ones. */
  constructor(viewer: Viewer, sources: { samples?: SampleSource; passes?: PassSource } = {}) {
    this.viewer = viewer;
    this.#samples = sources.samples ?? new WorkerSampleSource();
    // A worker separate from sampling; see passWorker.
    this.#passes = sources.passes ?? new WorkerPassSource();
    this.orbits = new PolylineBatch(viewer, "inertial", ORBIT_LINE_COLOR);
    this.tracks = new PolylineBatch(viewer, "fixed", ORBIT_TRACK_LINE_COLOR);
    this.groundTracks = new GroundTrackBatch(viewer);
    this.#recuts = new RecutSchedule(viewer.clock.currentTime);
    viewer.clock.onTick.addEventListener(() => {
      this.#refreshDerivedGeometry(viewer.clock.currentTime);
    });

    // The user can also start tracking by clicking the globe. Report it rather
    // than reaching for the store, so this class stays free of Pinia.
    this.viewer.trackedEntityChanged.addEventListener(() => {
      // The gap while a replaced satellite is rebuilt is no change of track.
      if (this.#retracking !== undefined && !this.trackedSatellite) {
        return;
      }
      this.#retracking = undefined;
      this.#onTrackedChange?.(this.trackedSatellite);
    });

    returnAfterTracking(this.viewer);

    // Any other selection, by click or by select(), supersedes a pending one.
    this.viewer.selectedEntityChanged.addEventListener(() => {
      this.#pendingSelection = undefined;
    });

    // A track waits out a morph (`#trackPending`).
    this.viewer.scene.morphComplete.addEventListener(() => this.#trackPending());

    // New entries may fall into the activation target, e.g. a URL-enabled name or
    // a pending tracked satellite.
    this.catalog.onChange(() => {
      this.#onCatalogChange?.();
      this.#reconcileActive();
    });
  }

  onCatalogChange(callback: () => void): void {
    this.#onCatalogChange = callback;
  }

  onTrackedChange(callback: (name: string) => void): void {
    this.#onTrackedChange = callback;
  }

  /** Drop a track still waiting on its model, which would otherwise start its flight whenever the model loads. */
  cancelPendingTrack(): void {
    cancelPendingTrack(this.viewer);
  }

  /**
   * Runs `morph`, keeping the tracked satellite through it: Cesium clears the tracked object as
   * a morph starts (`SceneTransitioner`). The loss goes unreported, and the satellite is tracked
   * again once the morph ends.
   */
  keepTrackThroughMorph(morph: () => void): void {
    const name = this.trackedSatellite;
    this.#retracking = name || undefined;
    morph();
    if (!name || this.trackedSatellite) {
      // Nothing tracked, or a refused morph, which keeps the track.
      this.#retracking = undefined;
      return;
    }
    this.pendingTrackedSatellite = name;
  }

  /** Tracks the pending satellite once it is built, and not mid-morph, which a track aborts. */
  #trackPending(): void {
    if (!this.pendingTrackedSatellite || this.viewer.scene.mode === SceneMode.MORPHING) {
      return;
    }
    const sat = this.getSatellite(this.pendingTrackedSatellite);
    if (sat) {
      sat.track();
      this.pendingTrackedSatellite = undefined;
    }
  }

  #onCatalogChange: (() => void) | undefined;

  #effectiveComponents(): string[] {
    return this.#components.inForce;
  }

  /** Diffed against the previous scene, so it is cheap to call on every store change. */
  reconcile(desired: DesiredScene): void {
    const previous = this.#desired;
    this.#desired = desired;

    if (
      !sameValue(previous.enabledTags, desired.enabledTags) ||
      !sameValue(previous.enabledSatellites, desired.enabledSatellites) ||
      previous.trackedSatellite !== desired.trackedSatellite
    ) {
      void this.#ensureCatalogCoverage();
    }

    if (!sameValue(previous.groundStations, desired.groundStations)) {
      this.#applyGroundStations(desired.groundStations);
    }

    if (previous.overpassMode !== desired.overpassMode) {
      this.#applyOverpassMode(desired.overpassMode);
    }

    if (!sameValue(previous.components, desired.components)) {
      this.#components.choose(desired.components);
    }

    if (previous.trackedSatellite !== desired.trackedSatellite) {
      this.#applyTracked(desired.trackedSatellite);
    }

    this.#reconcileActive();
  }

  #applyOverpassMode(mode: string): void {
    this.activeSatellites.forEach((sat) => {
      // The mode setter clears the predictor's window; recompute so pass-dependent visuals update.
      sat.props.passPredictor.mode = mode;
      if (sat.props.passPredictor.groundStationAvailable) {
        sat.props.passPredictor.passes(this.viewer.clock.currentTime);
      }
    });
  }

  #applyGroundStations(stations: readonly SerializedGroundStation[]): void {
    this.#stations.forEach((station) => station.hide());
    this.#stations = stations.map((station, index) =>
      this.#createGroundstation(
        {
          latitude: station.lat,
          longitude: station.lon,
          height: 0,
          cartesian: Cartesian3.fromDegrees(station.lon, station.lat, 0),
        },
        station.name ?? "",
        index,
      ),
    );
    this.activeSatellites.forEach((sat) => {
      sat.groundStations = this.#stations;
    });
  }

  #applyTracked(name: string): void {
    if (!name) {
      if (this.trackedSatellite) {
        this.viewer.trackedEntity = undefined;
      }
      this.pendingTrackedSatellite = undefined;
      this.#retracking = undefined;
      return;
    }
    if (name === this.trackedSatellite) {
      return;
    }
    // An unknown name stays pending until catalog coverage loads its entry.
    this.pendingTrackedSatellite = name;
  }

  /** Only the groups the activation state needs load now; the rest load on demand. */
  loadElementSets(sourceTagList: ReadonlyArray<ElementsEntry>): Promise<void> {
    this.catalog.registerGroups(sourceTagList);
    this.#onCatalogChange?.();
    void this.catalog.ensureIndex().then(() => this.#onCatalogChange?.());
    return this.#ensureCatalogCoverage();
  }

  /**
   * Loads every group when an enabled or pending-tracked name is unknown: its
   * group cannot be known without loading.
   */
  #ensureCatalogCoverage(): Promise<void> {
    const loads = [this.catalog.ensureTags(this.#desired.enabledTags)];
    const names = [...this.#desired.enabledSatellites];
    if (this.pendingTrackedSatellite) {
      names.push(this.pendingTrackedSatellite);
    }
    if (names.some((name) => this.catalog.getByName(name) === undefined)) {
      loads.push(this.catalog.ensureAll());
    }
    return Promise.all(loads).then(() => undefined);
  }

  /** For tests: records under `tags`, as a group's would load. */
  addRecords(records: GpRecord[], tags: string[]): void {
    this.catalog.addRecords(records, tags);
    this.#onCatalogChange?.();
    this.#reconcileActive();
  }

  /** Replaces the custom satellites with `records`; a record kept keeps its satellite. */
  setCustomRecords(records: readonly GpRecord[]): void {
    const kept = new Set(records);
    const present = this.catalog.entriesWithTag(CUSTOM_TAG).filter(isCustom);
    const presentRecords = new Set(present.map((entry) => entry.record));
    this.catalog.remove(present.filter((entry) => !kept.has(entry.record)));
    const fresh = records.filter((record) => !presentRecords.has(record));
    for (const record of fresh) {
      this.#propagationKeys.set(record, `custom-${this.#customRecordCount++}`);
    }
    this.catalog.addRecords(fresh, [CUSTOM_TAG], CUSTOM_KEY_PREFIX);
    this.#onCatalogChange?.();
    this.#reconcileActive();
  }

  /**
   * The workers cache one satrec per key, so a custom satellite, which may share a satnum with
   * another, has a key of its own (ADR 0014).
   */
  #propagationKey(entry: CatalogEntry): string {
    return this.#propagationKeys.get(entry.record) ?? entry.satnum;
  }

  #activeTargetEntries(): Map<string, CatalogEntry> {
    return activeTargetEntries({
      entries: this.catalog.entries,
      enabledTags: this.#desired.enabledTags,
      enabledSatellites: this.#desired.enabledSatellites,
      disabledSatellites: this.#desired.disabledSatellites,
      trackedName: this.trackedSatellite || undefined,
      pendingTrackedName: this.pendingTrackedSatellite,
    });
  }

  /** Re-cut the orbit tracks as simulation time passes (RecutSchedule). */
  #refreshDerivedGeometry(time: JulianDate): void {
    if (!this.#recuts.tick(time, this.#active.size)) {
      return;
    }
    for (const sat of this.#active.values()) {
      sat.recut("Orbit track", time);
    }
  }

  #reconcileActive(): void {
    const target = this.#activeTargetEntries();

    let disposed = false;
    for (const [key, sat] of this.#active) {
      // An entry replaced under its key is built again.
      if (target.get(key) === sat.props.entry) {
        continue;
      }
      if (sat.isTracked) {
        // Replaced under its key: tracked again once rebuilt.
        if (target.has(key)) {
          this.#retracking = sat.props.name;
          this.pendingTrackedSatellite = sat.props.name;
        }
        // Before dispose, so Cesium keeps no dangling trackedEntity.
        this.viewer.trackedEntity = undefined;
      }
      sat.dispose();
      this.#active.delete(key);
      disposed = true;
    }

    this.#queue = buildOrder(
      [...target].filter(([key]) => !this.#active.has(key)),
      this.pendingTrackedSatellite || this.#pendingSelection || this.trackedSatellite || undefined,
    );
    this.#ready = [];
    this.#requestOpeningWindows();
    this.#build();

    // On any shrink, not only to zero: Cesium leaves glyph billboards behind in
    // proportion to the labels removed. The helper gates itself on pool size.
    if (disposed) {
      CesiumCleanupHelper.cleanup(this.viewer);
    }
  }

  /**
   * Instantiate ready satellites within BUILD_BUDGET_MS per frame. Unbudgeted,
   * 5,000 satellites froze one frame for 908 ms (points) to 1,617 ms (orbits).
   */
  #build(): void {
    // A reconcile mid-build calls #build directly; cancel the frame already booked,
    // or this frame spends two budgets.
    if (this.#buildHandle !== undefined) {
      cancelAnimationFrame(this.#buildHandle);
      this.#buildHandle = undefined;
    }

    const deadline = performance.now() + BUILD_BUDGET_MS;
    while (this.#ready.length > 0) {
      const next = this.#ready.shift();
      if (!next) break;
      this.#queue = this.#queue.filter(([queued]) => queued !== next.key);
      this.#instantiate(next.key, next.entry, next.chunk);
      // After at least one satellite, so a tiny budget still makes progress.
      if (performance.now() >= deadline) break;
    }

    this.#trackPending();
    if (this.#pendingSelection) {
      this.select(this.#pendingSelection);
    }

    if (this.#ready.length > 0 || this.#opening > 0) {
      // Not clock.onTick: under requestRenderMode a tick needs a render request,
      // and a half-built scene asking for none would stall.
      this.#buildHandle = requestAnimationFrame(() => this.#build());
      this.viewer.scene.requestRender();
      return;
    }

    this.#buildHandle = undefined;
    this.viewer.scene.requestRender();
    this.#resolveSettledIfDone();
  }

  #resolveSettledIfDone(): void {
    if (this.#ready.length > 0 || this.#opening > 0) {
      return;
    }
    const waiters = this.#buildWaiters;
    this.#buildWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * All at once: the source coalesces a synchronous burst into one message and
   * replies in order, so the build consumes the front while the tail propagates.
   */
  #requestOpeningWindows(): void {
    const nowMs = JulianDate.toDate(this.viewer.clock.currentTime).getTime();
    for (const [key, entry] of this.#queue) {
      // From the element set, not a satrec: `sgp4init` per satellite here would
      // freeze the page. The sampler answers on its own exact grid.
      const periodMs = approximatePeriodMinutes(entry.record) * 60_000;
      if (periodMs <= 0) {
        continue;
      }
      this.#opening += 1;
      void this.#samples
        .samplerFor(this.#propagationKey(entry), entry.record)
        .samples(nowMs - periodMs * WINDOW_ORBITS_BACK, nowMs + periodMs * WINDOW_ORBITS_FORWARD)
        .then((chunk) => {
          // The queue says whether this satellite is still wanted, and not replaced under its key.
          if (chunk && chunk.positionsFixed.length > 0 && this.#queue.some(([queued, wanted]) => queued === key && wanted === entry)) {
            this.#ready.push({ key, entry, chunk });
          }
        })
        .finally(() => {
          this.#opening -= 1;
          this.#resolveSettledIfDone();
        });
    }
  }

  #instantiate(key: string, entry: CatalogEntry, chunk: SampleChunk): void {
    // A reconcile during opening windows re-requests every queued satellite
    // without cancelling the requests already out, so two replies can arrive for one key.
    if (this.#active.has(key)) {
      return;
    }
    const sat = new SatelliteComponentCollection(
      this.viewer,
      entry,
      { orbits: this.orbits, tracks: this.tracks, groundTracks: this.groundTracks },
      this.#samples.samplerFor(this.#propagationKey(entry), entry.record),
      this.#passes.predictorFor(entry.name, entry.record),
      chunk,
    );
    sat.props.passPredictor.mode = this.#desired.overpassMode;
    sat.show(this.#effectiveComponents());
    // After show(): `defaultEntity` is the first entity created, and it must not
    // be the ground-station link, which is invisible outside a pass.
    if (this.groundStationAvailable) {
      sat.groundStations = this.#stations;
    }
    this.#active.set(key, sat);
  }

  /** Resolves once no satellites are waiting to be built. */
  buildSettled(): Promise<void> {
    if (this.#ready.length === 0 && this.#opening === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#buildWaiters.push(resolve);
    });
  }

  get building(): boolean {
    return this.#ready.length > 0 || this.#opening > 0;
  }

  /** Derived from Cesium; set it through reconcile. */
  get trackedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isTracked) {
        return sat.props.name;
      }
    }
    return "";
  }

  get visibleSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()].filter((sat) => sat.created);
  }

  /** Active satellites only; use `cc.sats.catalog.getByName` for any entry. */
  getSatellite(name: string): SatelliteComponentCollection | undefined {
    for (const sat of this.#active.values()) {
      if (sat.props.name === name) {
        return sat;
      }
    }
    return undefined;
  }

  /** Opens the info panel. A satellite not built yet is selected once it is. */
  select(name: string): void {
    const entity = this.getSatellite(name)?.defaultEntity;
    this.#pendingSelection = entity ? undefined : name;
    if (entity) {
      this.viewer.selectedEntity = entity;
    }
  }

  get activeSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()];
  }

  get enabledComponents(): string[] {
    return this.#effectiveComponents();
  }

  /** Hide a component for a scene morph, leaving the user's choice and the toolbar unchanged. */
  suppressComponent(componentName: string): boolean {
    return this.#components.suppress(componentName);
  }

  releaseComponent(componentName: string): void {
    this.#components.release(componentName);
  }

  #showComponent(componentName: string): void {
    this.activeSatellites.forEach((sat) => {
      sat.enableComponent(componentName);
    });
  }

  #hideComponent(componentName: string): void {
    this.activeSatellites.forEach((sat) => {
      sat.disableComponent(componentName);
    });
  }

  get groundStationAvailable(): boolean {
    return this.#stations.length > 0;
  }

  #createGroundstation(position: GroundStationPositionData, name: string, index: number): GroundStationEntity {
    const groundStation = new GroundStationEntity(this.viewer, position, name, index);
    groundStation.show();
    return groundStation;
  }

  get groundStations(): GroundStationEntity[] {
    return this.#stations;
  }

  /** The drawn satellites' passes over the station named `name`, starting within two days of `time`. */
  stationPasses(name: string, time: JulianDate): Pass[] {
    return stationPasses(
      this.visibleSatellites.map((sat) => sat.props.passPredictor),
      time,
      name,
    );
  }

  /** Whether every drawn satellite's prediction has answered for `time`. */
  stationPassesSettled(time: JulianDate): boolean {
    return stationPassesSettled(
      this.visibleSatellites.map((sat) => sat.props.passPredictor),
      time,
    );
  }

  get overpassMode(): string {
    return this.#desired.overpassMode;
  }
}
