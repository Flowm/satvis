<!-- The header is always visible; the orbit, the spacecraft, the passes and a station's
     location are tabs, because stacking them overflowed a 500 px window by almost 900 px. -->
<template>
  <div v-if="selection" class="entity-info-panel">
    <UCard :ui="{ root: 'bg-(--panel-surface-dense) text-(--panel-ink) divide-(--panel-hairline)', header: 'p-2 sm:px-3', body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="head">
          <div class="head__title">
            <input
              v-if="renaming"
              ref="renameEl"
              v-model="draftName"
              class="head__rename"
              type="text"
              placeholder="unnamed"
              aria-label="Station name"
              @keydown.enter="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="head__name">{{ name }}</span>
            <UTooltip v-if="canRename" :text="renaming ? 'Done' : 'Rename'">
              <!-- mousedown.prevent keeps focus in the input, so a press commits once via the click, not also via the blur. -->
              <UButton
                :icon="renaming ? 'i-lucide-check' : 'i-lucide-pencil'"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="renaming ? 'Finish renaming' : 'Rename station'"
                @mousedown.prevent
                @click="toggleRename"
              />
            </UTooltip>
            <span class="head__gap" />
            <UTooltip text="Notify for upcoming passes">
              <UButton icon="i-lucide-bell" variant="ghost" color="neutral" size="xs" aria-label="Notify for upcoming passes" @click="notifyForPasses" />
            </UTooltip>
            <UTooltip v-if="canEnterSkyView" text="View the sky from here">
              <UButton icon="i-lucide-telescope" variant="ghost" color="neutral" size="xs" aria-label="View the sky from this ground station" @click="enterSkyView" />
            </UTooltip>
            <UTooltip v-if="latestRecorded && !inSkyView" :text="`Replay the last imaged overpass: ${latestRecorded.satellite} over ${latestRecorded.station}`">
              <UButton icon="i-lucide-history" variant="ghost" color="neutral" size="xs" aria-label="Replay the last imaged overpass" @click="replayRecorded(latestRecorded)" />
            </UTooltip>
            <!-- Hidden, not disabled, in the sky view: that view owns the camera. -->
            <UTooltip v-if="!inSkyView" :text="isTracked ? 'Stop tracking' : 'Track entity'">
              <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track entity" @click="toggleTrack" />
            </UTooltip>
            <UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="Close" @click="deselect" />
          </div>
          <div v-if="satnum || chips.length > 0" class="head__chips">
            <span v-if="satnum" class="head__id">#{{ satnum }}</span>
            <!-- The first chip is the orbit, in the colour the globe and the satellite list draw it. -->
            <span
              v-for="(chip, index) in chips"
              :key="chip"
              :class="{ 'head__chip--status': chip === satelliteInfo?.status }"
              :style="index === 0 && orbitColor ? { color: orbitColor } : undefined"
              >{{ chip }}</span
            >
          </div>
        </div>
      </template>

      <div v-if="staleNotice" class="stale" title="Only the latest element set is kept, so positions far from its epoch drift by kilometres to thousands of kilometres.">
        <UIcon name="i-lucide-triangle-alert" class="stale__icon" />
        <span>{{ staleNotice }}</span>
      </div>

      <!-- The tab row shows even with one tab: pressing it folds the body.
           `min-h-8` reserves the height of a badged trigger, so the row does not grow when the pass count arrives.
           Too narrow a row scrolls rather than cutting the labels to "Space…", as on a phone. A scroller clips its
           border, where the indicator sits, so the bottom line is an inset shadow and the indicator sits above it. -->
      <UTabs
        v-model="activeTab"
        :items="tabs"
        variant="link"
        size="sm"
        :ui="{
          root: 'gap-0',
          list: 'px-2 border-t border-b-0 border-neutral-600 shadow-[inset_0_-1px_var(--color-neutral-600)] overflow-x-auto overflow-y-hidden [scrollbar-width:none]',
          indicator: 'bottom-0',
          trigger: 'min-h-8 shrink-0',
          content: collapsed ? 'hidden' : 'px-3 pb-3 info-body',
        }"
      >
        <template #trailing="{ item }">
          <span v-if="item.badge" class="countBadge">{{ item.badge }}</span>
        </template>
        <template #passes>
          <div class="tab-body__pad">
            <template v-if="!passesPending && hasAnyPasses">
              <div v-if="nextPass" class="hero" :class="{ 'hero--live': isOngoing }">
                <div class="hero__label">
                  {{ isOngoing ? "Overhead now" : "Next pass" }}
                  <span v-if="nextPassSubject">· {{ nextPassSubject }}</span>
                </div>
                <div class="hero__value">{{ formatCountdown(nowMs, nextPass) }}</div>
                <div class="hero__meta">{{ passSummary(nextPass) }}</div>
                <div v-if="isOngoing" class="hero__progress"><span :style="{ width: `${ongoingFraction * 100}%` }" /></div>
              </div>

              <pass-timeline v-if="showTimeline" :passes="passes" :now-ms="nowMs" :mode="overpassMode" :picked="pickedPassMs" @pick="pickPass" />
            </template>

            <div v-if="latestRecorded" class="latest-replay">
              <UIcon name="lucide:history" class="latest-replay__icon" />
              <span class="latest-replay__text">
                <span class="latest-replay__label">Last imaged</span>
                {{ latestRecorded.satellite }} over {{ latestRecorded.station }} · {{ utcMinute(latestRecorded.overpass.start) }} UTC
              </span>
              <UButton icon="i-lucide-play" size="xs" variant="soft" label="Replay" :title="`Replay it, with its granules`" @click="replayRecorded(latestRecorded)" />
            </div>

            <!-- Outside the empty branches: swath mode can empty the list, and the switch back must stay reachable. -->
            <div class="passes__bar">
              <segmented-control v-model="overpassMode" class="passes__modes" label="Overpass calculation" :options="OVERPASS_MODES" />
              <USwitch v-model="showPastPasses" label="Past" size="xs" />
              <USwitch v-if="recorded.length > 0" v-model="onlyImaged" label="Imaged" size="xs" />
            </div>

            <div v-if="passesPending" class="empty">Computing passes…</div>
            <div v-else-if="!hasAnyPasses" class="empty">{{ emptyPassText }}</div>
            <div v-else-if="tableRows.length === 0" class="empty">{{ onlyImaged ? "No imaged passes" : "No upcoming passes" }}</div>
            <table v-else ref="tableEl" class="info-table">
              <thead>
                <tr>
                  <th v-if="subjectCount > 1">{{ selection.kind === "groundstation" ? "Satellite" : "Station" }}</th>
                  <th>In</th>
                  <th>Start</th>
                  <th>End</th>
                  <th class="num">{{ overpassMode === "swath" ? "Dist" : "El" }}</th>
                  <th class="num">{{ overpassMode === "swath" ? "Swath" : "Az" }}</th>
                  <th v-if="recorded.length > 0" class="pass-imagery__head" aria-label="Imagery recorded" title="What the satellite recorded of the station">
                    <UIcon name="lucide:image" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in tableRows"
                  :key="row.key"
                  :data-start-ms="row.startMs"
                  :class="{ 'is-next': row.startMs === nextPass?.start, 'is-picked': row.startMs === pickedPassMs }"
                >
                  <td v-if="subjectCount > 1">{{ row.name }}</td>
                  <td class="mono">{{ row.countdown }}</td>
                  <td>
                    <a class="link" :title="`Replay this pass${row.recorded?.day ? ', with its granules' : ''}`" @click="replayRow(row)">{{ row.startLabel }}</a>
                  </td>
                  <td>{{ row.endLabel }}</td>
                  <td class="num">{{ row.primary }}</td>
                  <td class="num">{{ row.secondary }}</td>
                  <td v-if="recorded.length > 0" class="pass-imagery">
                    <button
                      v-if="row.recorded?.day"
                      type="button"
                      class="pass-replay"
                      :class="`pass-imagery--${imageryOf(row.recorded)}`"
                      :title="`${PASS_IMAGERY[imageryOf(row.recorded)].title}. Replay it, with its granules`"
                      :aria-label="`Replay, ${PASS_IMAGERY[imageryOf(row.recorded)].title}`"
                      @click="replayRow(row)"
                    >
                      <UIcon :name="PASS_IMAGERY[imageryOf(row.recorded)].icon" />
                    </button>
                    <UIcon
                      v-else-if="row.recorded"
                      :name="PASS_IMAGERY[imageryOf(row.recorded)].icon"
                      :class="`pass-imagery--${imageryOf(row.recorded)}`"
                      :title="PASS_IMAGERY[imageryOf(row.recorded)].title"
                      :aria-label="PASS_IMAGERY[imageryOf(row.recorded)].title"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template #orbit>
          <div class="tab-body__pad">
            <table v-if="satelliteInfo" class="info-table info-table--facts">
              <tbody>
                <tr v-for="[label, value] in satelliteInfo.orbitRows" :key="label">
                  <th>{{ label }}</th>
                  <td class="right">{{ value }}</td>
                </tr>
              </tbody>
            </table>

            <template v-if="orbitPositionRows.length > 0">
              <div class="section">Position</div>
              <table class="info-table info-table--facts">
                <tbody>
                  <tr v-for="row in orbitPositionRows" :key="row.label">
                    <th>{{ row.label }}</th>
                    <td class="right mono">{{ row.value }}</td>
                  </tr>
                </tbody>
              </table>
            </template>

            <template v-if="elements">
              <div class="section">Element set</div>
              <table class="info-table info-table--facts">
                <tbody>
                  <tr>
                    <th>Epoch</th>
                    <td class="right mono">{{ elements.epoch }} UTC</td>
                  </tr>
                  <template v-if="elements.kind === 'omm'">
                    <tr v-for="[label, value] in elements.rows" :key="label">
                      <th>{{ label }}</th>
                      <td class="right mono">{{ value }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
              <pre v-if="elements.kind === 'tle'" class="info-code"><code>{{ elements.lines }}</code></pre>
            </template>
          </div>
        </template>

        <template #location>
          <div class="tab-body__pad">
            <table class="info-table info-table--facts">
              <tbody>
                <tr v-for="row in locationRows" :key="row.label">
                  <th>{{ row.label }}</th>
                  <td class="right mono">{{ row.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template #spacecraft>
          <div class="tab-body__pad">
            <satellite-model-view v-if="modelFile && !collapsed" :model-file="modelFile" :name="name" />

            <table v-if="spacecraftRows.length > 0" class="info-table info-table--facts" :class="{ 'info-table--below-model': modelFile }">
              <tbody>
                <tr v-for="[label, value] in spacecraftRows" :key="label">
                  <th>{{ label }}</th>
                  <td class="right">{{ value }}</td>
                </tr>
              </tbody>
            </table>

            <template v-if="links.length > 0">
              <div class="section">Links</div>
              <div class="links">
                <a v-for="link in links" :key="link.label" class="links__item" :href="link.href" :title="link.title" target="_blank" rel="noopener">{{ link.label }}</a>
              </div>
            </template>
          </div>
        </template>

        <template #instruments>
          <div class="tab-body__pad">
            <instrument-list :instruments="instruments" @show-imagery="showImagery" />
            <a class="instruments__source" href="https://database.eohandbook.com" target="_blank" rel="noopener">CEOS MIM Database, CC BY 4.0</a>
          </div>
        </template>

        <template #imagery>
          <div class="tab-body__pad">
            <imagery-gallery :layers="imageryLayers" :centre="imageryCentre" :geostationary="orbitClass === 'GEO'" :focus="imageryFocus" />
          </div>
        </template>
      </UTabs>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "@nuxt/ui/composables/useToast";
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useLatestReplay } from "@/composables/useLatestReplay";
import { useRecordedOverpasses } from "@/composables/useRecordedOverpasses";
import { type InfoTab, useSelectedEntity } from "@/composables/useSelectedEntity";
import { externalLinks } from "@/config/externalLinks";
import { ORBIT_CLASS_COLOR } from "@/config/orbitClass";
import { SKY_MODE } from "@/config/viewModes";
import { type PassImagery, type PassTableRow, passTable, type RecordedOverpass } from "@/modules/passImagery";
import { formatCountdown, passSummary, type Pass } from "@/modules/PassPredictor";
import { formatInteger } from "@/modules/util/formats";
import { notifyPasses } from "@/modules/util/passNotifications";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

import ImageryGallery from "./ImageryGallery.vue";
import InstrumentList from "./InstrumentList.vue";
import PassTimeline from "./PassTimeline.vue";
import SatelliteModelView from "./SatelliteModelView.vue";
import SegmentedControl from "./SegmentedControl.vue";

const cc = useController();
const toast = useToast();

const {
  selection,
  isTracked,
  name,
  position,
  passRows,
  passes,
  nextPass,
  subjectCount,
  nowMs,
  hasAnyPasses,
  passesPending,
  showPastPasses,
  pickedPassMs,
  pickPass,
  preferredTab,
  infoCollapsed: collapsed,
  groundStationAvailable,
  elements,
  staleNotice,
  satelliteInfo,
  imageryCentre,
  canEnterSkyView,
  enterSkyView,
  deselect,
  toggleTrack,
} = useSelectedEntity(cc);

const satStore = useSatStore();
const { overpassMode } = storeToRefs(satStore);
const { sceneMode } = storeToRefs(useCesiumStore());
const inSkyView = computed(() => sceneMode.value === SKY_MODE);
const OVERPASS_MODES = [
  { value: "elevation", label: "Elevation" },
  { value: "swath", label: "Swath" },
] as const;

const { recorded, settled, imageryOf, replayPass } = useRecordedOverpasses(selection, passes);

/** The newest overpass the table records by day, which the header button and "Last imaged" replay. */
const latestRecorded = computed((): RecordedOverpass | undefined => recorded.value.filter((entry) => entry.day).toSorted((a, b) => b.overpass.start - a.overpass.start)[0]);
/** "11-22 11:48". */
const utcMinute = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

/** Replays a recorded overpass as its row would. */
function replayRecorded(entry: RecordedOverpass): void {
  scrollOnPasses = true;
  replayPass({ name: entry.satellite, start: entry.overpass.start, groundStationName: entry.station }, entry);
}

/** Only the passes recorded with a granule layer by day. */
const onlyImaged = ref(false);
// Imaged passes are past ones.
watch(onlyImaged, (on) => {
  if (on) showPastPasses.value = true;
});
/** A recorded pass's mark, and what it says. */
const PASS_IMAGERY: Record<PassImagery, { icon: string; title: string }> = {
  asking: { icon: "lucide:ellipsis", title: "Asking for the image" },
  image: { icon: "lucide:image", title: "Imaged: the picture is there" },
  part: { icon: "lucide:image", title: "Imaged: part of the picture is there" },
  outline: { icon: "lucide:square-dashed", title: "Recorded, but no picture: granule outlines only" },
  night: { icon: "lucide:moon", title: "Recorded by night: no true colour picture" },
};
/** The pass behind a row: a predicted one, or the overpass CMR recorded where the predictor has none. */
function passOf(row: PassTableRow): { name?: string; start: number; groundStationName?: string } {
  return passes.value.find((pass) => pass.start === row.startMs) ?? { start: row.startMs };
}
/** The passes with what was recorded in them, and with Past the recorded overpasses the predictor no longer has. */
const tableRows = computed(() => {
  const table = passTable(passRows.value, passes.value, recorded.value, {
    nowMs: nowMs.value,
    showPast: showPastPasses.value,
    subject: selection.value?.kind === "satellite" ? "station" : "satellite",
  });
  return onlyImaged.value ? table.filter((row) => row.recorded?.day) : table;
});

const emptyPassText = computed(() => (groundStationAvailable.value ? "No passes in the prediction window" : "No ground station set"));

const satnum = computed(() => (selection.value?.kind === "satellite" ? selection.value.sat.props.satnum : undefined));
const links = computed(() => (satnum.value ? externalLinks(satnum.value) : []));
/** Empty for a ground station, or a record with no metadata. */
const spacecraftRows = computed(() => satelliteInfo.value?.spacecraftRows ?? []);
/** Empty for all but the few hundred satellites CEOS lists (ADR 0018). */
const instruments = computed(() => satelliteInfo.value?.instruments ?? []);
/** Every instrument's layers, in the order of the instruments. */
const imageryLayers = computed(() => instruments.value.flatMap((instrument) => instrument.imagery.map((imagery) => ({ instrument: instrument.name, imagery }))));
/** The instrument whose imagery button opened the Imagery tab. */
const imageryFocus = ref<string>();
/** Only satellites a model manifest lists have one (ADR 0007). */
const modelFile = computed(() => (selection.value?.kind === "satellite" ? selection.value.sat.props.model?.file : undefined));

const orbitClass = computed(() => satelliteInfo.value?.orbitClass);
const orbitColor = computed(() => (orbitClass.value ? ORBIT_CLASS_COLOR[orbitClass.value] : undefined));
const chips = computed(() => satelliteInfo.value?.chips ?? []);

/** A satellite's position sits in its Orbit tab, a ground station's in its Location tab. */
const orbitPositionRows = computed(() => (selection.value?.kind === "satellite" ? position.value : []));
const locationRows = computed(() => (selection.value?.kind === "groundstation" ? position.value : []));

const isOngoing = computed(() => !!nextPass.value && nextPass.value.start <= nowMs.value);
const ongoingFraction = computed(() => {
  const pass = nextPass.value;
  if (!pass || pass.end <= pass.start) {
    return 0;
  }
  return Math.min(1, Math.max(0, (nowMs.value - pass.start) / (pass.end - pass.start)));
});
/** The other side of the pass from the panel's subject, as the iOS app's headline: a station's names the satellite. */
const nextPassSubject = computed(() => {
  const pass = nextPass.value;
  if (!pass) {
    return "";
  }
  return (selection.value?.kind === "groundstation" ? pass.name : pass.groundStationName) ?? "";
});

/** A station's passes are too dense for a timeline; see PassTimeline.vue. */
const showTimeline = computed(() => selection.value?.kind === "satellite");

const tabs = computed(() => {
  const items: { label: string; slot: InfoTab; value: InfoTab; badge?: number }[] = [];
  if (satelliteInfo.value || elements.value || orbitPositionRows.value.length > 0) {
    items.push({ label: "Orbit", slot: "orbit", value: "orbit" });
  }
  if (modelFile.value || spacecraftRows.value.length > 0 || links.value.length > 0) {
    items.push({ label: "Spacecraft", slot: "spacecraft", value: "spacecraft" });
  }
  if (instruments.value.length > 0) {
    items.push({ label: "Instruments", slot: "instruments", value: "instruments" });
  }
  if (imageryLayers.value.length > 0) {
    items.push({ label: "Imagery", slot: "imagery", value: "imagery", badge: imageryLayers.value.length });
  }
  items.push({ label: "Passes", slot: "passes", value: "passes", ...(passRows.value.length > 0 ? { badge: passRows.value.length } : {}) });
  // After Passes, so a station opens on it: a preferred tab the selection lacks falls back to the first.
  if (locationRows.value.length > 0) {
    items.push({ label: "Location", slot: "location", value: "location" });
  }
  return items;
});

/**
 * Controlled, not left to UTabs: the component is not remounted across selections,
 * and an uncontrolled UTabs keeps a tab the new selection lacks (a ground station has no Orbit).
 */
const resolvedTab = computed<InfoTab>(() => (tabs.value.some((item) => item.value === preferredTab.value) ? preferredTab.value : (tabs.value[0]?.value ?? "passes")));

// The panel is not remounted between entities, so a new selection unfolds it here.
watch(selection, () => {
  collapsed.value = false;
  imageryFocus.value = undefined;
});

const activeTab = computed({
  get: () => resolvedTab.value,
  set: (value: string) => {
    // Reka's trigger sets the model on every press, so a press on the active tab arrives as its own value.
    if (value === resolvedTab.value) {
      collapsed.value = !collapsed.value;
      return;
    }
    const tab = tabs.value.find((item) => item.value === value);
    if (tab) {
      collapsed.value = false;
      preferredTab.value = tab.value;
      // An Imagery tab opened any other way starts at the top.
      imageryFocus.value = undefined;
    }
  },
});

function showImagery(instrument: string): void {
  activeTab.value = "imagery";
  imageryFocus.value = instrument;
}

const tableEl = useTemplateRef<HTMLTableElement>("tableEl");

/** Brings the pass the clock is at to the middle: with Past, a month of passes lies above it. */
function scrollToNow(): void {
  void nextTick(() => {
    const rows = [...(tableEl.value?.tBodies[0]?.rows ?? [])];
    const at = nextPass.value?.start ?? nowMs.value;
    (rows.find((row) => Number(row.dataset.startMs) >= at) ?? rows.at(-1))?.scrollIntoView({ block: "center" });
  });
}
watch([showPastPasses, onlyImaged], scrollToNow);

/** Set by a replay until the table has the passes around its time: the table unmounts while they are computed. */
let scrollOnPasses = false;
watch([tableEl, () => nextPass.value?.start], () => {
  if (scrollOnPasses && tableEl.value && !passesPending.value) {
    scrollOnPasses = false;
    scrollToNow();
  }
});

// A replay asked for elsewhere, once this table has listed what it records.
const { request: latestRequest } = useLatestReplay();
watch(
  [latestRequest, settled, passesPending, name],
  () => {
    const asked = latestRequest.value;
    if (asked === undefined || asked.subject !== name.value || passesPending.value || !settled.value) return;
    latestRequest.value = undefined;
    if (latestRecorded.value !== undefined) {
      replayRecorded(latestRecorded.value);
      return;
    }
    toast.add({ title: "Nothing to replay", description: "No overpass by day recorded in the last 30 days.", color: "neutral" });
  },
  { immediate: true },
);

/** Replays the row's pass, and keeps it in view once the table has moved to its time. */
function replayRow(row: PassTableRow): void {
  scrollOnPasses = true;
  replayPass(passOf(row), row.recorded);
}
watch(pickedPassMs, (startMs) => {
  if (startMs === null) {
    return;
  }
  // Wait for the row's class, so `nearest` measures the right element.
  nextTick(() => {
    tableEl.value?.querySelector(`tr[data-start-ms="${startMs}"]`)?.scrollIntoView({ block: "nearest" });
  });
});

const canRename = computed(() => selection.value?.kind === "groundstation");
const renaming = ref(false);
const renameEl = useTemplateRef<HTMLInputElement>("renameEl");
/**
 * Local, not bound to the station: Vue patches `:value` against the live DOM value,
 * so a bound input loses the typing on every one-second refresh. Seeded from
 * `givenName`, because the displayed fallback (coordinates) has a comma that `wireSafeName` refuses.
 */
const draftName = ref("");

watch(selection, () => {
  renaming.value = false;
});

function toggleRename(): void {
  if (renaming.value) {
    commitRename();
    return;
  }
  draftName.value = selection.value?.kind === "groundstation" ? selection.value.gs.givenName : "";
  renaming.value = true;
  // Select after the input mounts, so typing replaces the name.
  nextTick(() => renameEl.value?.select());
}

function cancelRename(): void {
  renaming.value = false;
}

/**
 * Blur commits as well as Enter. The `renaming` guard stops the blur that fires when
 * Escape unmounts the input from committing. Matched by list position, not by the old name.
 */
function commitRename(): void {
  if (!renaming.value) {
    return;
  }
  renaming.value = false;
  const sel = selection.value;
  if (sel?.kind !== "groundstation") {
    return;
  }
  const { index } = sel.gs;
  satStore.renameGroundStation(index, draftName.value);
  // The write rebuilds every station entity and drops the selection; re-select the replacement.
  nextTick(() => cc.sats.groundStations[index]?.select());
}

function notifyForPasses(): void {
  if (!cc.sats.groundStationAvailable) {
    toast.add({
      color: "warning",
      title: "Warning",
      description: "Ground station required to notify for passes",
      duration: 3000,
    });
    return;
  }
  let upcoming: Pass[] = [];
  if (selection.value?.kind === "satellite") {
    upcoming = selection.value.sat.props.passPredictor.passes(cc.viewer.clock.currentTime);
  } else if (selection.value?.kind === "groundstation") {
    upcoming = cc.sats.stationPasses(selection.value.gs.name, cc.viewer.clock.currentTime);
  }
  if (upcoming.length === 0) {
    toast.add({
      color: "info",
      title: "Info",
      description: "No passes available",
      duration: 3000,
    });
    return;
  }
  notifyPasses(upcoming);
  toast.add({
    color: "success",
    title: "Success",
    description: `Notifying for ${formatInteger(upcoming.length)} passes`,
    duration: 3000,
  });
}
</script>

<style scoped>
/* The width loses both side insets, or the card overflows beside a landscape notch. */
.entity-info-panel {
  position: absolute;
  /* Below the top row, as far from it as the row is from the edge. */
  top: calc(2 * var(--edge) + var(--toolbar-row) + var(--safe-top, 0px));
  right: calc(var(--edge) + var(--safe-right, 0px));
  width: calc(100% - 2 * var(--edge) - var(--safe-left, 0px) - var(--safe-right, 0px));
  max-width: 540px;
  z-index: 5;
  font-size: 14px;
  /* The body turns selection off for the globe; the name, position and facts are worth copying. Safari needs the prefix. */
  -webkit-user-select: text;
  user-select: text;
}

/* In the top-right corner where the menu column leaves room, as the iOS app's card, over
   the top-right buttons, which hide under it (main.css). A phone keeps it under the top row,
   clear of the menu toggle (`PHONE_WIDTH`, src/config/layout.ts). */
@media (min-width: 640px) {
  .entity-info-panel {
    top: calc(var(--edge) + var(--safe-top, 0px));
    /* Clear of the open menu column, a gap from it as from the screen's edge. */
    max-width: min(540px, calc(100% - 3 * var(--edge) - var(--menu-width) - var(--safe-left, 0px) - var(--safe-right, 0px)));
  }
}

/* A long press on a tab or a pass control would select its label. */
.entity-info-panel :deep([role="tablist"]),
.passes__bar {
  -webkit-user-select: none;
  user-select: none;
}

/* dvh, not vh: an installed iOS app reports vh as the full screen, taller than the viewport it paints. */
.entity-info-panel :deep(.info-body) {
  max-height: min(520px, 58dvh);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.head__title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.head__name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Matches .head__name, so entering edit mode moves nothing. */
.head__rename {
  min-width: 0;
  flex: 1;
  padding: 0 4px;
  border: 1px solid #ffffff40;
  border-radius: 3px;
  background: #0000004d;
  color: inherit;
  font-size: 16px;
  font-weight: 600;
}

/* Keeps the buttons at the right edge however short the name. */
.head__gap {
  flex-grow: 1;
}

.head__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding-left: 2px;
  color: #edffffb0;
  font-size: 11px;
}

.head__id {
  font-variant-numeric: tabular-nums;
}

/* Amber: the app colour for "away from rest", as on the stale notice. */
.head__chip--status {
  color: var(--panel-amber);
}

.head__chips span:not(:last-child)::after {
  margin-left: 6px;
  color: #edffff60;
  content: "·";
}

/* Amber: the app colour for "away from rest", as on the clock's reset. */
.stale {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #ffd47914;
  color: var(--panel-amber);
  font-size: 11px;
}

.stale__icon {
  flex-shrink: 0;
}

.hero {
  margin-bottom: 10px;
  padding: 8px 10px 10px;
  border-radius: 4px;
  background: var(--panel-raised);
}

/* Green only while the pass is under way, as the iOS app's headline. */
.hero--live {
  background: linear-gradient(color-mix(in srgb, var(--panel-green) 20%, transparent), color-mix(in srgb, var(--panel-green) 6%, transparent)), var(--panel-raised);
}

.hero__label {
  color: var(--panel-muted);
  font-size: var(--text-section);
}

.hero--live .hero__label {
  color: var(--panel-green);
}

.hero__value {
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  font-weight: 300;
  line-height: 1.1;
}

.hero__meta {
  margin-top: 2px;
  color: #edffffcc;
  font-size: 12.5px;
}

.hero__progress {
  margin-top: 8px;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: #ffffff20;
}

.hero__progress span {
  display: block;
  height: 100%;
  background: var(--panel-green);
}

/* Here, not on the scroll container, so the sticky table header pins flush and rows do not show above it. */
.tab-body__pad {
  padding-top: 12px;
}

/* A recorded pass's mark: an icon, its tooltip the words. */
.pass-imagery,
.pass-imagery__head {
  width: 1%;
  text-align: center;
}

.pass-imagery--asking,
.pass-imagery--outline,
.pass-imagery--night {
  color: var(--panel-muted);
}

.pass-imagery--image {
  color: var(--panel-ink);
}

.pass-imagery--part {
  color: var(--panel-amber);
}

/* A recorded pass's mark as a button, which replays it. */
.pass-replay {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
}

.pass-replay:hover {
  background: #edffff1f;
}

/* The newest recorded overpass, one press from its replay. */
.latest-replay {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--panel-hairline);
  border-radius: 8px;
  font-size: 12.5px;
}

.latest-replay__icon {
  flex: none;
  color: var(--panel-accent);
}

.latest-replay__text {
  flex: 1;
  min-width: 0;
}

.latest-replay__label {
  display: block;
  color: var(--panel-muted);
  font-size: 11px;
}

/* A pair rather than a switch: "Swath: off" is not what the other mode is called. */
.passes__modes {
  flex: 0 1 200px;
  margin: 0;
}

.passes__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0 6px;
  color: #edffff90;
  font-size: 13px;
}

/* The menu panels' section heading (`.toolbarTitle`), as the iOS app's list headers. */
.section {
  margin: 12px 0 5px;
  color: var(--panel-muted);
  font-size: var(--text-section);
  font-weight: 600;
  line-height: 16px;
}

.instruments__source {
  display: block;
  margin-top: 10px;
  color: var(--panel-muted);
  font-size: 11px;
}

.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.info-table th,
.info-table td {
  padding: 3px 6px;
  text-align: left;
}

.info-table tbody tr:nth-child(odd) {
  background: #ffffff08;
}

.info-table--below-model {
  margin-top: 10px;
}

.info-table--facts tbody th {
  color: #edffffb0;
  font-weight: 400;
}

.info-table thead th {
  position: sticky;
  top: 0;
  background: #383b3e;
  color: #edffffb0;
  font-size: var(--text-section);
  font-weight: 600;
}

.info-table tbody tr.is-next {
  box-shadow: inset 3px 0 #4caf50;
}

.info-table tbody tr.is-picked {
  background: #edffff1f;
  box-shadow: inset -3px 0 var(--panel-ink);
}

.info-table tbody tr.is-picked.is-next {
  box-shadow:
    inset 3px 0 #4caf50,
    inset -3px 0 var(--panel-ink);
}

.num,
.right {
  text-align: right !important;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.link {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.links__item {
  padding: 2px 7px;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
  color: #edffffdd;
  font-size: 11.5px;
}

.links__item:hover {
  border-color: #ffffff70;
  background: #ffffff14;
  color: #ffffff;
}

.info-code {
  margin: 0;
  padding: 4px;
  overflow-x: auto;
  background: #26262699;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.empty {
  padding: 10px 0;
  color: #edffffb0;
  text-align: center;
  font-size: 13px;
}
</style>
