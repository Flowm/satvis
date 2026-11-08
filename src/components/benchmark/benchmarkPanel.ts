// The benchmark panel's state, shared by its shell and both tabs: what is planned, what the
// shared runner is doing, and the status line. The runner fills its run in place, so every
// view of it reads `revision`, which a poll bumps; a run started from the console shows too.

import { computed, inject, onBeforeUnmount, provide, reactive, ref, shallowRef, type InjectionKey } from "vue";

import { usePostHog } from "@/composables/usePostHog";
import {
  type BenchmarkHandle,
  type BenchmarkOptions,
  type BenchmarkRun,
  type RunKind,
  buildPlan,
  CUMULATIVE_COMPONENT_SETS,
  DEFAULT_OPTIONS,
  driftSteps,
  estimateDurationMs,
  FOOTPRINT_CAPTURE_MS,
  ISOLATED_COMPONENT_SETS,
  NAMED_SWEEPS,
  planScenes,
  type PlanSpec,
  repeatChecks,
  type RunStatus,
  SCENE_STEP_ESTIMATE_MS,
  shownDrift,
  type SceneStep,
  sceneResults,
  statusLine,
  type SweepRun,
  sweepRunOf,
  type SweepStep,
} from "@/modules/benchmark";
import type { BenchmarkScene } from "@/modules/util/gpSource";

/** Also the kind of run each tab starts. */
export type Tab = RunKind;
/** The sweep's component sets: the ones on now, each alone, or added one by one. */
export type ComponentMode = "current" | "isolated" | "cumulative";

/** The sweep's settings, as the form holds them. */
export interface SweepForm {
  /** Satellite counts, comma- or space-separated. */
  countsText: string;
  /** Which component sets the sweep runs. */
  mode: ComponentMode;
  /** Clock multipliers, as the counts. */
  clocksText: string;
}

/** Rarely enough that reading it is not part of what is measured. */
const POLL_MS = 500;

/** The numbers in a settings field, between commas, spaces or an "x". */
const numbers = (text: string, parse: (part: string) => number): number[] =>
  text
    .split(/[\s,x×]+/)
    .filter((part) => part !== "")
    .map(parse);

/** The state, polled while the panel is mounted; `enabledComponents` are the sweep's current set. */
function createPanel(bench: BenchmarkHandle, enabledComponents: () => readonly string[]) {
  const revision = ref(0);
  const tab = ref<Tab>("scenes");
  const scenes = shallowRef<readonly BenchmarkScene[]>([]);
  const selected = ref<string[]>([]);
  const report = shallowRef<Record<string, unknown>>();
  const sent = ref(false);
  // Initialised only on satvis.space with a project key (usePostHog.ts).
  const analyticsOn = (usePostHog().posthog as { __loaded?: boolean }).__loaded === true;
  const form = reactive<SweepForm>({
    countsText: NAMED_SWEEPS.run.satelliteCounts.join(", "),
    mode: "current",
    clocksText: "1",
  });

  const running = computed(() => {
    void revision.value;
    return bench.runner.running;
  });

  const sceneSteps = computed(() => {
    // `planScenes` reads no ids as every scene.
    if (selected.value.length === 0) {
      return [];
    }
    const all = selected.value.length === scenes.value.length;
    return planScenes(scenes.value, all ? [] : scenes.value.filter((scene) => selected.value.includes(scene.id)).map((scene) => scene.id));
  });

  const spec = computed<PlanSpec>(() => ({
    satelliteCounts: numbers(form.countsText, (part) => Number(part)),
    componentSets: form.mode === "isolated" ? ISOLATED_COMPONENT_SETS : form.mode === "cumulative" ? CUMULATIVE_COMPONENT_SETS : [[...enabledComponents()]],
    clockMultipliers: numbers(form.clocksText, (part) => Number(part)),
  }));
  const sweepSteps = computed(() => buildPlan(spec.value));
  const sweepStepMs = (options: Pick<BenchmarkOptions, "warmupMs" | "sampleMs" | "captureFootprint">): number =>
    estimateDurationMs([undefined], options.warmupMs + options.sampleMs, options.captureFootprint ? FOOTPRINT_CAPTURE_MS : 0);

  // The last run of a kind, or the one going.
  const lastRun = <K extends Tab>(kind: K): BenchmarkRun<K extends "scenes" ? SceneStep : SweepStep> | undefined => {
    void revision.value;
    const run = bench.runner.run;
    return run?.kind === kind ? (run as BenchmarkRun<K extends "scenes" ? SceneStep : SweepStep>) : undefined;
  };
  const sceneRun = computed(() => lastRun("scenes"));
  const sweepRun = computed<SweepRun | undefined>(() => {
    const run = lastRun("sweep");
    return run ? sweepRunOf(run) : undefined;
  });

  const runStatus = computed<RunStatus>(() => {
    void revision.value;
    const progress = bench.runner.progress;
    if (progress) {
      const stepMs = progress.kind === "scenes" ? SCENE_STEP_ESTIMATE_MS : sweepStepMs(progress.options);
      const elapsed = performance.now() - progress.stepStartedAt;
      return { ...progress, remainingMs: Math.max(0, (progress.total - progress.index) * stepMs - elapsed) };
    }
    const kind = tab.value;
    const run = bench.runner.run;
    if (run?.kind === kind) {
      if (run.cancelled) {
        return { phase: "cancelled", kind, index: 0, total: run.planned, remainingMs: 0, measured: run.results.length };
      }
      const [first, repeated] =
        kind === "scenes"
          ? (driftSteps(sceneResults(run as BenchmarkRun<SceneStep>), run.planned)?.map((result) => result.summary.cpuMs) ?? [])
          : (() => {
              const check = repeatChecks(sweepRunOf(run as BenchmarkRun<SweepStep>))[0];
              return [check?.firstCpuMs, check?.repeatCpuMs];
            })();
      const driftPct = shownDrift(first, repeated);
      return { phase: "done", kind, index: 0, total: run.planned, remainingMs: 0, driftPct };
    }
    const total = kind === "scenes" ? sceneSteps.value.length : sweepSteps.value.length;
    const estimate = kind === "scenes" ? total * SCENE_STEP_ESTIMATE_MS : sweepStepMs(DEFAULT_OPTIONS) * total;
    return { phase: "idle", kind, index: 0, total, remainingMs: estimate };
  });

  // Why the last run started here failed, until the next one starts: the runner keeps no failed run.
  const failure = ref<string>();
  const status = computed(() => (failure.value === undefined ? statusLine(runStatus.value) : `Failed · ${failure.value}`));

  const progressFraction = computed<number | null>(() => {
    const value = runStatus.value;
    if (value.phase === "idle") {
      return null;
    }
    if (value.phase === "done" || value.phase === "cancelled") {
      return (value.phase === "done" ? value.total : (value.measured ?? 0)) / Math.max(value.total, 1);
    }
    const progress = bench.runner.progress;
    const stepMs = progress?.kind === "scenes" ? SCENE_STEP_ESTIMATE_MS : progress ? sweepStepMs(progress.options) : 1;
    const within = progress ? Math.min(0.95, (performance.now() - progress.stepStartedAt) / stepMs) : 0;
    return (value.index + within) / Math.max(value.total, 1);
  });

  async function startScenes(only?: readonly string[]): Promise<void> {
    sent.value = false;
    report.value = undefined;
    failure.value = undefined;
    const ids = only ?? (selected.value.length === scenes.value.length ? [] : sceneSteps.value.map((step) => step.id));
    try {
      const done = bench.scenes({ only: ids, hooks: { onResult: bump, onProgress: bump } });
      bump();
      report.value = await done;
    } catch (error) {
      fail(error);
    } finally {
      bump();
    }
  }

  async function startSweep(): Promise<void> {
    failure.value = undefined;
    try {
      const done = bench.runner.sweep(spec.value, DEFAULT_OPTIONS, { onResult: bump, onProgress: bump });
      bump();
      await done;
    } catch (error) {
      fail(error);
    } finally {
      bump();
    }
  }

  function send(): void {
    sent.value = bench.send();
  }

  // Logs the error and shows it on the status line.
  function fail(error: unknown): void {
    console.error("benchmark run failed", error);
    failure.value = error instanceof Error ? error.message : String(error);
  }

  // Has every view read the runner again.
  function bump(): void {
    revision.value += 1;
  }

  let wasRunning = false;
  const timer = setInterval(() => {
    // A console run has no hooks here: its end brings its report.
    if (wasRunning && !bench.runner.running && bench.runner.run?.kind === "scenes") {
      report.value = bench.report;
    }
    wasRunning = bench.runner.running;
    bump();
  }, POLL_MS);
  onBeforeUnmount(() => clearInterval(timer));

  return {
    /** The shared `window.bench`. */
    bench,
    /** Read by every view of the runner, to be read again as it changes. */
    revision,
    /** The tab on show, whose kind the status line describes between runs. */
    tab,
    /** The route's benchmark scenes, once resolved. */
    scenes,
    /** Scene ids; every scene once they arrive. */
    selected,
    /** The last scene run's report, as `bench.scenes` resolved it. */
    report,
    /** Whether `report` went where usage is counted. */
    sent,
    /** Whether `send` can send: PostHog loads only on satvis.space. */
    analyticsOn,
    /** The sweep's settings. */
    form,
    /** Whether the shared runner has a run going, from either tab or the console. */
    running,
    /** The scenes the Run button runs: all with the drift repeat, or the ticked ones without. */
    sceneSteps,
    /** The steps the sweep's settings plan. */
    sweepSteps,
    /** The last scene run, or the one going. */
    sceneRun,
    /** The last sweep, or the one going, in the tables' shape. */
    sweepRun,
    /** The status line's facts, for the current tab where no run is going. */
    runStatus,
    /** The status line's words. */
    status,
    /** Shown during a run and after one: done steps plus how far the current one is. */
    progressFraction,
    /** Runs `only`, or the ticked scenes. */
    startScenes,
    /** Runs the sweep the settings plan. */
    startSweep,
    /** Sends the last scene run's report where usage is counted, setting `sent`. */
    send,
    /** Cancels the run going, whichever tab or the console started it. */
    cancel: () => bench.runner.cancel(),
  };
}

/** What the shell provides its tabs. */
export type BenchmarkPanelState = ReturnType<typeof createPanel>;

/** Provided by the shell. */
const KEY: InjectionKey<BenchmarkPanelState> = Symbol("benchmark-panel");

/** In the shell: the state its tabs share. */
export function provideBenchmarkPanel(bench: BenchmarkHandle, enabledComponents: () => readonly string[]): BenchmarkPanelState {
  const panel = createPanel(bench, enabledComponents);
  provide(KEY, panel);
  return panel;
}

/** In a tab. */
export function useBenchmarkPanel(): BenchmarkPanelState {
  const panel = inject(KEY);
  if (!panel) {
    throw new Error("useBenchmarkPanel outside the benchmark panel");
  }
  return panel;
}
