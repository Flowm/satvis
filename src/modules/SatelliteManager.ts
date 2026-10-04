import { Cartesian3, JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { SATELLITE_COMPONENTS } from "../config/components";
import type { ElementsEntry } from "../config/presets";
import type { SerializedGroundStation } from "../stores/sat";
import { GroundStationEntity, type GroundStationPositionData } from "./GroundStationEntity";
import { activeTargetEntries, buildOrder } from "./satelliteActivation";
import { type CatalogEntry, SatelliteCatalog } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { geometryRefreshSeconds } from "./satelliteGraphics";
import { CesiumCleanupHelper } from "./util/CesiumCleanupHelper";
import { sameValue } from "./util/equality";
import { approximatePeriodMinutes, type GpRecord } from "./util/gp";
import { type PassSource, WorkerPassSource } from "./util/passSource";
import { PolylineBatch } from "./util/PolylineBatch";
import { type SampleChunk, type SampleSource, type SampleSourceStats, WorkerSampleSource } from "./util/sampleSource";
import { SuppressibleSet } from "./util/Suppressible";
import { WINDOW_ORBITS_BACK, WINDOW_ORBITS_FORWARD } from "./util/trajectoryWindow";

/**
 * Frames between corridor re-cuts when nothing can say whether the last one has
 * landed. See #groundTracksSettled for what normally answers that.
 *
 * Cesium owns the corridor batch and rebuilds it asynchronously, so a re-cut
 * arriving before the last one lands discards it rather than overtaking it, and
 * the corridor on screen keeps whatever shape last made it through. Re-cut
 * faster than the rebuild lands and the ground track stops dead while the rest
 * of the scene keeps moving — which is what a schedule in *simulation* seconds
 * did from about ×64 up.
 *
 * Thirty is safe rather than smooth: the rebuild measured 4 frames at fifty
 * corridors and 25 at fifteen hundred, and only the top of that range needs a
 * number this large.
 *
 * In ticks of the clock, not rendered frames. The two differ only where
 * `requestRenderMode` skips a frame nothing asked for, and a rebuild in flight
 * asks for every one — so an idle scene at ×1 (60 ticks a second, 22 of them
 * drawn) is not held to the rate at which it happens to repaint.
 */
const GROUND_TRACK_REFRESH_FRAMES = 30;

/**
 * How long one frame may spend instantiating satellites. See #build.
 *
 * This trades the length of the worst frame against how long the scene takes to
 * finish arriving, and 16 ms is where that stopped being a good deal. Measured
 * at 5,000 satellites, worst frame gap and total build time:
 *
 *      budget   Point        + Label      + Orbit       + Orbit track
 *      none     908 / 982    950 / 1216   1617 / 1678   951 / 1013
 *       8 ms     58 / 1998    92 / 4656     82 / 4067    83 / 2567
 *      16 ms     41 / 1477    91 / 2956     82 / 2822    73 / 1711
 *      32 ms     50 / 1241   100 / 2094    125 / 2421    51 / 1313
 *
 * At 32 ms a frame goes back over 100 ms, which is a hitch someone can feel; at
 * 8 ms the scene takes four and a half seconds to fill in. Note that the worst
 * frame is not the budget plus a little — it is the budget plus the render, and
 * rendering five thousand labelled satellites is itself 40 ms, which is why the
 * gaps sit where they do and why a bigger budget buys less than it looks like.
 */
const BUILD_BUDGET_MS = 16;

/**
 * Below this a build runs to completion synchronously.
 *
 * Deferring is only worth its latency when the alternative is a visible freeze.
 * The default scene is 74 satellites and fits inside one budget regardless, so
 * spreading it would add a frame of delay to the common case and save nothing.
 */
const BUILD_SYNCHRONOUS_LIMIT = 250;

/**
 * Everything the globe should be showing. The manager holds no opinion of its
 * own about any of it — the store decides, this is the value it hands over.
 */
export interface DesiredScene {
  enabledTags: string[];
  enabledSatellites: string[];
  disabledSatellites: string[];
  components: string[];
  groundStations: SerializedGroundStation[];
  overpassMode: string;
  trackedSatellite: string;
}

const EMPTY_SCENE: DesiredScene = {
  enabledTags: [],
  enabledSatellites: [],
  disabledSatellites: [],
  components: [],
  groundStations: [],
  overpassMode: "elevation",
  trackedSatellite: "",
};

export class SatelliteManager {
  // The last scene handed to reconcile. Nothing else mirrors store state.
  #desired: DesiredScene = EMPTY_SCENE;

  /**
   * Which components are drawn. The user's choice comes from the desired scene;
   * a scene morph hides Orbit for its duration, which is a Cesium concern and
   * must not be mistaken for the user turning it off. The set remembers what it
   * last put on screen, so nothing here has to reconstruct it to find the diff.
   */
  #components = new SuppressibleSet(({ show, hide }) => {
    show.forEach((name) => this.#showComponent(name));
    hide.forEach((name) => this.#hideComponent(name));
  });

  #stations: GroundStationEntity[] = [];

  #onTrackedChange: ((name: string) => void) | undefined;

  viewer: Viewer;

  readonly catalog = new SatelliteCatalog();

  /**
   * The shared primitive every untracked orbit is drawn into. Owned here because
   * this is what owns the collections that feed it; it used to be four statics on
   * their base class.
   */
  readonly orbits: PolylineBatch;

  /**
   * The same, for the Orbit track. A second batch rather than a second colour in
   * the first one: the orbit is inertial and the track is Earth-relative, so they
   * need different model matrices and cannot share a primitive.
   */
  readonly tracks: PolylineBatch;

  // Live collections keyed by catalog entry key. Satellites are instantiated
  // lazily: only entries in the current activation target (see #reconcileActive)
  // have a collection here; everything else stays a plain catalog entry.
  #active = new Map<string, SatelliteComponentCollection>();

  availableComponents: string[] = [...SATELLITE_COMPONENTS];

  pendingTrackedSatellite: string | undefined;

  /** Simulation time the batched orbit tracks were last re-cut at. See #refreshDerivedGeometry. */
  #tracksRefreshedAt: JulianDate;

  /** Simulation time the ground-track corridors were last re-cut at. */
  #groundTracksRefreshedAt: JulianDate;

  /** Frames since this manager existed. See GROUND_TRACK_REFRESH_FRAMES. */
  #frames = 0;

  /** The frame the ground-track corridors were last re-cut on. */
  #groundTracksRefreshedOnFrame = 0;

  /**
   * The frame that re-cut landed on, or undefined while it is still in flight.
   * Starts landed, so the first corridors of a scene are not made to wait out a
   * rebuild that never happened.
   */
  #groundTracksLandedOnFrame: number | undefined = 0;

  /** Key of the satellite whose corridor is asked whether the batch has caught up. */
  #groundTrackProbe: string | undefined;

  /**
   * Where every satellite's samples come from. Owned here because this is what
   * knows which satellites exist; handed to each one as a bound sampler.
   */
  readonly #samples: SampleSource = new WorkerSampleSource();

  /**
   * Where pass prediction happens. Its own worker, not the sampling one — see
   * passWorker for why a slow batch job must not queue behind the samples that
   * keep satellites moving.
   */
  readonly #passes: PassSource = new WorkerPassSource();

  /**
   * Satellites whose opening window has arrived, waiting to be instantiated.
   *
   * The build drains this rather than the queue directly: a satellite is only
   * created once it has a position, so there is no moment at which one exists
   * without one and no main-thread propagation to cover the gap.
   */
  #ready: Array<{ key: string; entry: CatalogEntry; chunk: SampleChunk }> = [];

  /** Opening windows still in flight. Counted so the build knows to keep waiting. */
  #opening = 0;

  /** Catalog entries waiting to be instantiated, in the order they will be. See #build. */
  #queue: [string, CatalogEntry][] = [];

  /** Whether this activation is small enough to skip the per-frame budget. See #build. */
  #unbudgetedBuild = true;

  #buildHandle: number | undefined;

  #buildWaiters: Array<() => void> = [];

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.orbits = new PolylineBatch(viewer, "inertial");
    this.tracks = new PolylineBatch(viewer, "fixed");
    this.#tracksRefreshedAt = viewer.clock.currentTime;
    this.#groundTracksRefreshedAt = viewer.clock.currentTime;
    // Considered every frame rather than on a grid of its own: the decision is a
    // few comparisons, and a grid quantises — a re-cut declined because the last
    // one is still landing waits out the whole next square, which at ×1 turned a
    // re-cut a second into one every two.
    viewer.clock.onTick.addEventListener(() => {
      this.#frames += 1;
      this.#refreshDerivedGeometry(viewer.clock.currentTime);
    });

    // Tracking is the one genuinely two-way value: the user can also start it
    // by clicking a satellite on the globe. Report it rather than reaching for
    // the store, so this class stays free of Pinia.
    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.trackedSatellite) {
        this.getSatellite(this.trackedSatellite)?.show(this.#effectiveComponents());
      }
      this.#onTrackedChange?.(this.trackedSatellite);
    });

    // New/changed catalog entries may fall into the current activation target
    // (e.g. URL-enabled names or a pendingTrackedSatellite that arrives once the
    // catalog finishes loading), so bump the revision and reconcile.
    this.catalog.onChange(() => {
      this.#onCatalogChange?.();
      this.#reconcileActive();
    });
  }

  /** Called whenever the catalog gains or changes entries. */
  onCatalogChange(callback: () => void): void {
    this.#onCatalogChange = callback;
  }

  onTrackedChange(callback: (name: string) => void): void {
    this.#onTrackedChange = callback;
  }

  #onCatalogChange: (() => void) | undefined;

  #effectiveComponents(): string[] {
    return this.#components.inForce;
  }

  /**
   * Make the globe match `desired`. Diffed against the previous scene, so it
   * is cheap to call on every store change and there is no path by which the
   * manager can disagree with the store.
   */
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
      // The mode setter clears the predictor's window on change; recompute
      // eagerly so pass-dependent visuals update without waiting for a read.
      sat.props.passPredictor.mode = mode;
      if (sat.props.passPredictor.groundStationAvailable) {
        sat.props.passPredictor.passes(this.viewer.clock.currentTime);
      }
    });
  }

  #applyGroundStations(stations: readonly SerializedGroundStation[]): void {
    this.#stations.forEach((station) => station.hide());
    this.#stations = stations.map((station) =>
      this.createGroundstation(
        {
          latitude: station.lat,
          longitude: station.lon,
          height: 0,
          cartesian: Cartesian3.fromDegrees(station.lon, station.lat, 0),
        },
        station.name ?? "",
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
      return;
    }
    if (name === this.trackedSatellite) {
      return;
    }
    // If the name is unknown to the catalog (yet?), reconciling is a no-op and
    // the pending name survives until a matching entry is loaded — coverage
    // kicks off the group loads that can make it resolvable.
    this.pendingTrackedSatellite = name;
  }

  // Register the preset's element sets with the catalog. Groups are NOT
  // fetched here — only the ones required by the current activation state
  // (enabled tags, URL-enabled/tracked names) load now; the rest load on
  // demand when their tag is enabled or the catalog browser needs them.
  loadElementSets(sourceTagList: ReadonlyArray<ElementsEntry>): Promise<void> {
    this.catalog.registerGroups(sourceTagList);
    // Registered groups become visible in the browser immediately; their
    // estimated counts follow once the group index arrives.
    this.#onCatalogChange?.();
    void this.catalog.ensureIndex().then(() => this.#onCatalogChange?.());
    return this.#ensureCatalogCoverage();
  }

  // Load the catalog groups the current activation state depends on: groups
  // carrying an enabled tag, plus everything if a name-based activation
  // (URL-enabled sats, pending track) cannot be resolved yet — the group of an
  // unknown name is unknowable without loading.
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

  // Passthrough for custom inline records (e.g. console/testing usage).
  addCustomRecords(records: GpRecord[], tags: string[]): void {
    this.catalog.addRecords(records, tags);
    this.#onCatalogChange?.();
    this.#reconcileActive();
  }

  // Catalog entries that should currently be instantiated: enabled by tag
  // (minus per-member opt-outs), enabled by name, or the tracked /
  // pending-tracked satellite.
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

  /**
   * Advance the geometry that goes stale as the clock runs: the batched orbit
   * tracks and the ground-track corridors. Both are rebuilt rather than
   * re-oriented, and neither is cheap enough to do per frame — see
   * `geometryRefreshSeconds` for the budget this spends.
   *
   * On a simulation-time callback, because what makes them stale is simulated
   * time passing rather than wall time: at ×1000 the satellites move a thousand
   * times faster and the geometry has to keep up. The orbit batch's coalescing
   * window turns however many satellites there are into a single primitive
   * rebuild, and a rebuild already in flight holds the window open, so a clock
   * fast enough to outrun the rebuild degrades into "as often as it can" rather
   * than into a queue.
   *
   * The interval runs from when the last rebuild *finished*, not from when it
   * was asked for, which is what the pending guard buys: at five thousand tracks
   * a rebuild can take longer than the interval, and measuring from the request
   * meant the next refresh was already overdue the moment the previous one
   * landed. That is a treadmill, and it measured 8.2% janked frames against 0.5%
   * for a rebuild that simply waits its turn.
   *
   * The cadence is scaled by the number of active satellites rather than by a
   * count of each kind of geometry: it is an upper bound on both, it is free to
   * read, and the interval only has to be roughly right.
   *
   * The two halves share that budget but not the leash, because different things
   * hold them back. The orbit batch is ours and says when it is busy, so it waits
   * on `pending`; the corridors are Cesium's, so they wait on
   * `groundTrackSettled` — the same question, put to whoever owns the rebuild.
   *
   * They used to share `pending`, which starved the corridors: a track rebuild is
   * coalescing or in flight for most of its cycle, and none of those frames re-cut
   * the corridors either, for no reason. With both components on one satellite the
   * corridor advanced once in 7.5 s at ×1 and once in 13 s at ×1000, against once
   * and twice a second with the guards separated.
   */
  #refreshDerivedGeometry(time: JulianDate): void {
    if (this.#active.size === 0) {
      return;
    }
    const due = geometryRefreshSeconds(this.#active.size);
    const stale = (since: JulianDate): boolean => Math.abs(JulianDate.secondsDifference(time, since)) >= due;

    // A rebuild in flight holds the window open rather than queueing behind it,
    // and the interval then runs from when that rebuild finished rather than from
    // when it was asked for.
    if (this.tracks.pending) {
      this.#tracksRefreshedAt = time;
    }
    const tracksDue = !this.tracks.pending && stale(this.#tracksRefreshedAt);
    // Asked ahead of the budget, not behind it: the rebuild is timed by when it
    // was seen to land, so behind the budget the first look comes a whole budget
    // late and doubles the interval it was meant to shorten.
    const groundTracksRested = this.#groundTracksRested();
    const groundTracksDue = groundTracksRested && stale(this.#groundTracksRefreshedAt);
    if (!tracksDue && !groundTracksDue) {
      return;
    }
    if (tracksDue) {
      this.#tracksRefreshedAt = time;
    }
    if (groundTracksDue) {
      this.#groundTracksRefreshedAt = time;
      this.#groundTracksRefreshedOnFrame = this.#frames;
      this.#groundTracksLandedOnFrame = undefined;
    }
    for (const sat of this.#active.values()) {
      if (tracksDue) {
        sat.refreshOrbitTrack(time);
      }
      if (groundTracksDue) {
        sat.refreshGroundTrack(time);
      }
    }
  }

  /**
   * Whether the last re-cut has landed *and* left the machine to itself for as
   * long again since.
   *
   * Waiting for the rebuild keeps the ground track moving; the idle spell after
   * it keeps the rest of the scene moving. Re-cutting the instant one lands
   * leaves Cesium no frame without corridor geometry in flight, which at 1,542
   * corridors and ×1000 measured 6 fps and bought no smoothness at all — at that
   * size the rebuild sets the pace regardless.
   *
   * The rebuild times itself, so one rule covers both ends: four frames to land
   * means some eight re-cuts a second, thirty means room to breathe in between.
   * In frames rather than milliseconds because that stays stable under load — the
   * interval stretches as the frame rate falls, where a wall-clock ration keeps
   * asking for a rate that is already too fast. At 1,542 corridors and ×1000 it
   * settles at 46 fps and 2.9 re-cuts a second, against 27 fps and 0.95 for the
   * fixed schedule it replaces.
   */
  #groundTracksRested(): boolean {
    if (this.#groundTracksLandedOnFrame === undefined) {
      if (!this.#groundTracksSettled()) {
        return false;
      }
      this.#groundTracksLandedOnFrame = this.#frames;
    }
    const rebuild = this.#groundTracksLandedOnFrame - this.#groundTracksRefreshedOnFrame;
    return this.#frames - this.#groundTracksRefreshedOnFrame >= 2 * rebuild;
  }

  /**
   * Whether the corridors have caught up with the positions they were last given.
   *
   * One satellite answers for all of them: every corridor is an instance in the
   * same batch primitive, so Cesium finishes them together or not at all. Which
   * one answered is remembered, because finding another means walking the
   * activation — at ten thousand satellites, most without a ground track, not a
   * walk to repeat per frame.
   *
   * Falls back to GROUND_TRACK_REFRESH_FRAMES when nothing can answer: either no
   * ground tracks exist, where the answer does not matter, or Cesium no longer
   * offers the question, where a conservative schedule beats never waiting.
   */
  #groundTracksSettled(): boolean {
    const remembered = this.#groundTrackProbe === undefined ? undefined : this.#active.get(this.#groundTrackProbe)?.groundTrackSettled();
    if (remembered !== undefined) {
      return remembered;
    }
    // Checked before the walk rather than discovered by it: with the component
    // switched off no satellite can answer, and learning that the long way is a
    // walk per frame that finds nothing.
    if (!this.#effectiveComponents().includes("Ground track")) {
      return true;
    }
    for (const [key, sat] of this.#active) {
      const settled = sat.groundTrackSettled();
      if (settled !== undefined) {
        this.#groundTrackProbe = key;
        return settled;
      }
    }
    this.#groundTrackProbe = undefined;
    return this.#frames - this.#groundTracksRefreshedOnFrame >= GROUND_TRACK_REFRESH_FRAMES;
  }

  // Reconcile the live #active map against the activation target: dispose
  // collections that are no longer targeted, instantiate the ones that are
  // newly targeted, and resolve a pending track once its satellite exists.
  #reconcileActive(): void {
    const target = this.#activeTargetEntries();

    let disposed = false;
    for (const [key, sat] of this.#active) {
      if (target.has(key)) {
        continue;
      }
      if (sat.isTracked) {
        // Clear the tracked entity before tearing down its components so Cesium
        // does not keep a dangling trackedEntity reference.
        this.viewer.trackedEntity = undefined;
      }
      sat.dispose();
      this.#active.delete(key);
      disposed = true;
    }

    // Instantiate collections newly in the target — over as many frames as it
    // takes, tracked satellite first. See #build.
    this.#queue = buildOrder(
      [...target].filter(([key]) => !this.#active.has(key)),
      this.pendingTrackedSatellite || this.trackedSatellite || undefined,
    );
    // Small enough to build in one go, judged once. See #build.
    this.#unbudgetedBuild = this.#queue.length <= BUILD_SYNCHRONOUS_LIMIT;
    // Anything still waiting belonged to a scene that has been replaced.
    this.#ready = [];
    this.#requestOpeningWindows();
    this.#build();

    // Any shrink, not only a shrink to nothing: the glyph billboards Cesium
    // leaves behind are proportional to the labels that went away, and going
    // from 5,000 satellites to 74 never reaches zero. The helper is gated on the
    // size of the pool it finds rather than on the size of the drop, so calling
    // it on every disposal costs a walk of the primitive tree and nothing else.
    if (disposed) {
      CesiumCleanupHelper.cleanup(this.viewer);
    }
  }

  /**
   * Instantiate queued satellites, a frame's worth at a time.
   *
   * Building one satellite is dominated by propagating its opening sample
   * window — measured at 2,000 satellites, `SampledTrajectory.update` was 89% of
   * the whole reconcile against 3% for making the graphics. Times five thousand
   * that is most of a second in which the page presents no frames at all, and
   * before this it was exactly one frame long: measured 908 ms for points and
   * 1,617 ms with orbits, as a single gap in the rAF stream.
   *
   * So it is spent to a budget instead. The work is identical and the total wall
   * time barely moves; what changes is that the globe keeps drawing, and the
   * satellites arrive over a few frames rather than all at once behind a freeze.
   *
   * Small activations stay synchronous. Deferring the default 74 satellites
   * would put a frame's latency between clicking a group and seeing it for no
   * benefit — the whole batch fits inside one budget anyway.
   */
  #build(): void {
    // A reconcile that lands mid-build replaces the queue and calls straight in,
    // so the frame already booked would otherwise spend a second budget on the
    // new queue in the same turn.
    if (this.#buildHandle !== undefined) {
      cancelAnimationFrame(this.#buildHandle);
      this.#buildHandle = undefined;
    }

    // `#unbudgetedBuild` was decided from the queue as it stood when the activation
    // started, not from the queue as it drains. Re-deciding on every call meant the
    // last BUILD_SYNCHRONOUS_LIMIT satellites of every large build ran unbudgeted —
    // a frame of tens of milliseconds at the tail of exactly the builds the budget
    // exists to smooth.
    //
    // Without a frame callback there is nothing to spread the work over, and a
    // queue left half-drained would never be picked up again. That is the unit
    // test environment rather than any browser, and there the freeze this avoids
    // is not a freeze anyone is looking at.
    const unbudgeted = this.#unbudgetedBuild || typeof requestAnimationFrame !== "function";
    const deadline = performance.now() + BUILD_BUDGET_MS;
    // Drains the satellites whose samples have arrived, not the queue itself. A
    // satellite still waiting for its opening window is simply not here yet.
    while (this.#ready.length > 0) {
      const next = this.#ready.shift();
      if (!next) break;
      this.#queue = this.#queue.filter(([queued]) => queued !== next.key);
      this.#instantiate(next.key, next.entry, next.chunk);
      // Checked after at least one satellite, so a budget smaller than a single
      // satellite still makes progress rather than spinning on the same entry.
      if (!unbudgeted && performance.now() >= deadline) break;
    }

    // Resolve a pending track as soon as its satellite exists, which the queue
    // ordering above tries to make the first thing that happens.
    if (this.pendingTrackedSatellite) {
      const sat = this.getSatellite(this.pendingTrackedSatellite);
      if (sat) {
        sat.track();
        this.pendingTrackedSatellite = undefined;
      }
    }

    if (this.#ready.length > 0 || this.#opening > 0) {
      // requestAnimationFrame rather than clock.onTick: under requestRenderMode
      // a tick only happens if something asked for a frame, and a half-built
      // scene asking for nothing would stall the rest of itself forever.
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
   * Ask for every queued satellite's opening window, in queue order.
   *
   * All at once rather than in waves: the source coalesces a synchronous burst
   * onto one message per turn, and the replies come back in the order they were
   * asked for, so the build starts consuming the front of the queue while the tail
   * is still being propagated.
   */
  #requestOpeningWindows(): void {
    const nowMs = JulianDate.toDate(this.viewer.clock.currentTime).getTime();
    for (const [key, entry] of this.#queue) {
      // Bounds from the element set, not from a satrec: this loop runs once per
      // satellite in the activation and `sgp4init` in it would be the freeze the
      // build budget exists to prevent. Approximate is all a bound needs to be —
      // the sampler answers on its own exact grid. See approximatePeriodMinutes.
      const periodMs = approximatePeriodMinutes(entry.record) * 60_000;
      if (periodMs <= 0) {
        continue;
      }
      this.#opening += 1;
      void this.#samples
        .samplerFor(entry.satnum, entry.record)
        .samples(nowMs - periodMs * WINDOW_ORBITS_BACK, nowMs + periodMs * WINDOW_ORBITS_FORWARD)
        .then((chunk) => {
          // The scene may have been replaced while this was in flight; the queue
          // is the authority on whether this satellite is still wanted.
          if (chunk && chunk.positionsFixed.length > 0 && this.#queue.some(([queued]) => queued === key)) {
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
    // Already built. Reachable whenever a reconcile lands while opening windows are
    // in flight — a group's records arriving, a component toggled, a ground station
    // edited — because that re-requests every queued satellite without cancelling
    // the requests already out, and both replies find their key still queued. Two
    // instantiations put two of everything on the globe and left the first
    // collection unreachable in `#active`, so its entities, its batch geometry and
    // its per-satellite tick listeners were never torn down.
    if (this.#active.has(key)) {
      return;
    }
    const sat = new SatelliteComponentCollection(
      this.viewer,
      entry,
      { orbits: this.orbits, tracks: this.tracks },
      this.#samples.samplerFor(entry.satnum, entry.record),
      this.#passes.predictorFor(entry.satnum, entry.record),
    );
    // Before show(), which is what reads the trajectory.
    sat.props.trajectory.adopt(chunk);
    sat.props.passPredictor.mode = this.#desired.overpassMode;
    sat.show(this.#effectiveComponents());
    // After show(): `defaultEntity` is "the first Entity to be created"
    // (SatelliteComponentCollection's own doc comment) and the ground-station
    // link is now a real, scene-attached Entity like any other component —
    // setting it before anything else would make the camera/selection default
    // to a polyline that is invisible outside a pass, instead of to Point (or
    // whatever the user actually chose). Harmless to set it after: the link
    // only shows at all once drawn, and setting it right away costs nothing
    // show() didn't already cost.
    if (this.groundStationAvailable) {
      sat.groundStations = this.#stations;
    }
    this.#active.set(key, sat);
  }

  /**
   * Resolves once no satellites are waiting to be built.
   *
   * The caller that needs this is anything reading the finished scene rather
   * than watching it appear — the benchmark, whose row would otherwise report
   * whatever fraction of the satellites had been created by the time the
   * synchronous part of `reconcile` returned.
   */
  buildSettled(): Promise<void> {
    if (this.#ready.length === 0 && this.#opening === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#buildWaiters.push(resolve);
    });
  }

  /** Whether satellites are still being instantiated or still waiting for samples. */
  get building(): boolean {
    return this.#ready.length > 0 || this.#opening > 0;
  }

  /** Sampling counters, so a benchmark can tell where the propagation happened. */
  get sampleStats(): SampleSourceStats {
    return this.#samples.stats;
  }

  get selectedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isSelected) {
        return sat.props.name;
      }
    }
    return "";
  }

  // Read-only: what the globe is tracking is derived from Cesium, and asking
  // for a different one goes through reconcile like every other desire.
  get trackedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isTracked) {
        return sat.props.name;
      }
    }
    return "";
  }

  // Active collections that have created components (i.e. are visible).
  get visibleSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()].filter((sat) => sat.created);
  }

  // Active-only lookup for selected/tracked/active names; console users
  // wanting arbitrary lookups should use `cc.sats.catalog.getByName`.
  getSatellite(name: string): SatelliteComponentCollection | undefined {
    for (const sat of this.#active.values()) {
      if (sat.props.name === name) {
        return sat;
      }
    }
    return undefined;
  }

  get activeSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()];
  }

  get enabledComponents(): string[] {
    return this.#effectiveComponents();
  }

  /**
   * Hide a component for the duration of a scene morph. Suppression is kept
   * apart from the desired scene on purpose: the user did not switch this off,
   * so the toolbar must go on showing it enabled.
   */
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

  focusGroundStation(): void {
    if (this.groundStationAvailable) {
      this.#stations[0]?.track();
    }
  }

  createGroundstation(position: GroundStationPositionData, name: string): GroundStationEntity {
    const groundStation = new GroundStationEntity(this.viewer, this, position, name);
    groundStation.show();
    return groundStation;
  }

  get groundStations(): GroundStationEntity[] {
    return this.#stations;
  }

  get overpassMode(): string {
    return this.#desired.overpassMode;
  }
}
