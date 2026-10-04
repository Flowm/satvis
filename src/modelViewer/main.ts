// Every GLB under data/ side by side, in one scene, rendered by the same Cesium
// Model pipeline the app uses. Dev-only: open /models.html under `pnpm dev`.
//
// Models sit in the frame the app gives a satellite (VelocityOrientationProperty):
// X along the velocity, Z at the zenith. Here that frame is the local
// east-north-up frame of a point in orbit, so X is east and Z is up.

import "@cesium/widgets/Source/widgets.css";
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  DebugModelMatrixPrimitive,
  DirectionalLight,
  DistanceDisplayCondition,
  HeadingPitchRange,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Matrix4,
  Model,
  PerspectiveFrustum,
  ScreenSpaceEventType,
  Tonemapper,
  Transforms,
  VerticalOrigin,
  type Label,
} from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import YAML from "yaml";

import { installFramePumpIfRequested } from "../modules/benchmark/framePump";
import { glbStats, type GlbStats } from "./glbStats";

// Only the keys: the importers are never called, so nothing is bundled or fetched.
const MODEL_PATHS = Object.keys(import.meta.glob("/data/**/*.glb"));
// The model manifests the worker maps NORAD ids from (ADR 0007).
const MANIFESTS = import.meta.glob<string>(["/data/models/models.yaml", "/data/custom/*/models.yaml"], { query: "?raw", import: "default", eager: true });

interface ManifestSatellite {
  name?: string;
  noradId: number;
  decayed?: string | boolean;
}

/**
 * The satellites a manifest gives the model at `path`, matched where the file is
 * served: data/models for the submodule's, and for a plugin's where its sync
 * script copies it, data/custom/dist/models. A plugin's own source folder is not
 * matched; its copies elsewhere (Grafana variants) would be mistaken for it.
 */
function manifestSatellites(path: string): ManifestSatellite[] | undefined {
  for (const [manifestPath, text] of Object.entries(MANIFESTS)) {
    const servedFrom = manifestPath === "/data/models/models.yaml" ? "/data/models/" : "/data/custom/dist/models/";
    for (const model of (YAML.parse(text) as { models?: Array<{ file: string; satellites?: ManifestSatellite[] }> }).models ?? []) {
      if (path === `${servedFrom}${model.file}`) {
        return model.satellites ?? [];
      }
    }
  }
  return undefined;
}

type ScaleMode = "fit" | "true";

interface Entry {
  path: string;
  url: string;
  name: string;
  /** Its folder under data/, e.g. `models` or `custom/nasa`. */
  group: string;
  card: HTMLElement;
  /** Picked in the model dropdown. */
  visible: boolean;
  toggle: HTMLInputElement;
  stats?: GlbStats;
  error?: string;
  model?: Model;
  axes?: DebugModelMatrixPrimitive;
  label?: Label;
  /** Bounding sphere at scale 1, relative to the model origin. */
  radius?: number;
  center?: Cartesian3;
  /** Placed bounding sphere, in world coordinates. */
  sphere?: BoundingSphere;
  /** From the model manifests; undefined for a file none of them lists. */
  satellites?: ManifestSatellite[];
}

/** Where every model sits: 500 km above 0°N 0°E, out of the way of nothing. */
const ANCHOR = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 500_000));
const FIT_RADIUS = 1;
const CELL_PADDING = 1.4;
// Heading and pitch of the camera in the satellite frame (east is the velocity,
// north is port): heading 0 looks north, so it sees the starboard side.
const VIEWS: Record<string, [number, number]> = {
  starboard: [0, -0.3],
  port: [Math.PI, -0.3],
  front: [-Math.PI / 2, -0.2],
  rear: [Math.PI / 2, -0.2],
  top: [0, -Math.PI / 2 + 0.001],
  bottom: [0, Math.PI / 2 - 0.001],
};

const params = new URLSearchParams(location.search);
const controls = {
  scale: document.querySelector<HTMLSelectElement>("#scale")!,
  view: document.querySelector<HTMLSelectElement>("#view")!,
  axes: document.querySelector<HTMLInputElement>("#axes")!,
  wireframe: document.querySelector<HTMLInputElement>("#wireframe")!,
  bounds: document.querySelector<HTMLInputElement>("#bounds")!,
  headlight: document.querySelector<HTMLInputElement>("#headlight")!,
  all: document.querySelector<HTMLButtonElement>("#all")!,
  picker: document.querySelector<HTMLDetailsElement>("#picker")!,
  pickerList: document.querySelector<HTMLElement>("#picker-list")!,
};
controls.scale.value = params.get("scale") === "true" ? "true" : "fit";
controls.view.value = params.get("view") ?? "starboard";
if (!controls.view.value) {
  controls.view.value = "starboard";
}

const viewer = new Viewer("viewer", {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  globe: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  skyAtmosphere: false,
  skyBox: false,
  timeline: false,
});
installFramePumpIfRequested(viewer, location.search);

const { scene, camera } = viewer;
scene.backgroundColor = Color.fromCssColorString("#15171c");
// As the app renders them (createViewer.ts).
scene.highDynamicRange = true;
scene.postProcessStages.tonemapper = Tonemapper.ACES;
// Cubesats are 10 cm across; Cesium's defaults stop the camera a metre short.
(camera.frustum as PerspectiveFrustum).near = 0.001;
scene.screenSpaceCameraController.minimumZoomDistance = 0.001;

const keyLightDirection = Matrix4.multiplyByPointAsVector(ANCHOR, Cartesian3.normalize(new Cartesian3(1, 2, -1.5), new Cartesian3()), new Cartesian3());
const light = new DirectionalLight({ direction: keyLightDirection, intensity: 2 });
scene.light = light;
scene.preRender.addEventListener(() => {
  if (controls.headlight.checked) {
    Cartesian3.clone(camera.directionWC, light.direction);
  } else {
    Cartesian3.clone(keyLightDirection, light.direction);
  }
});

const labels = scene.primitives.add(new LabelCollection()) as LabelCollection;
const panel = document.querySelector<HTMLElement>("#panel")!;

// `?show=` lists the picked models by name; absent means all of them.
const shown = params.get("show")?.split(",");

const groupOf = (path: string): string => path.replace(/^\/data\//, "").replace(/\/[^/]+$/, "");
// The models the app ships come first; any other folder is something to compare them with.
const groupRank = (path: string): number => (path.startsWith("/data/models/") ? 0 : 1);
const groupHeadings = new Map<string, HTMLElement>();

const entries: Entry[] = MODEL_PATHS.toSorted((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b)).map((path) => {
  const name = path
    .split("/")
    .pop()!
    .replace(/\.glb$/, "");
  const group = groupOf(path);
  if (!groupHeadings.has(group)) {
    const heading = document.createElement("h3");
    heading.className = "group";
    heading.textContent = group;
    panel.append(heading);
    groupHeadings.set(group, heading);
    const header = document.createElement("button");
    header.type = "button";
    header.className = "group";
    header.textContent = group;
    header.title = "Show or hide this folder";
    header.addEventListener("click", () => {
      const members = entries.filter((entry) => entry.group === group);
      setVisible(members, !members.every((entry) => entry.visible));
    });
    controls.pickerList.append(header);
  }
  const card = document.createElement("div");
  card.className = "card";
  panel.append(card);
  const option = document.createElement("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  option.append(toggle, ` ${name}`);
  controls.pickerList.append(option);
  const entry: Entry = { path, url: `.${path}`, name, group, card, visible: shown?.includes(name) ?? true, toggle, satellites: manifestSatellites(path) };
  toggle.checked = entry.visible;
  toggle.addEventListener("change", () => setVisible([entry], toggle.checked));
  card.hidden = !entry.visible;
  card.addEventListener("click", () => select(entry));
  return entry;
});

let selected: Entry | undefined;
updatePickerSummary();

if (entries.length === 0) {
  panel.innerHTML = `<div class="card error">No GLB files under data/. A fresh worktree needs <code>git submodule update --init</code>.</div>`;
}

for (const entry of entries) {
  renderCard(entry);
  void load(entry);
}

async function load(entry: Entry): Promise<void> {
  try {
    const response = await fetch(entry.url);
    // A missing file is index.html with a 200 under `pnpm dev`.
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
      throw new Error(`HTTP ${response.status} ${response.headers.get("content-type") ?? ""}`);
    }
    const buffer = await response.arrayBuffer();
    entry.stats = glbStats(buffer);
    renderCard(entry);
    void measureImages(entry);

    const model = await Model.fromGltfAsync({
      url: entry.url,
      modelMatrix: ANCHOR,
      show: false,
      enableDebugWireframe: true,
    });
    scene.primitives.add(model);
    entry.model = model;
    model.readyEvent.addEventListener(() => {
      const sphere = model.boundingSphere;
      entry.radius = sphere.radius;
      entry.center = Matrix4.multiplyByPoint(Matrix4.inverseTransformation(ANCHOR, new Matrix4()), sphere.center, new Cartesian3());
      entry.label = labels.add({
        position: Matrix4.getTranslation(ANCHOR, new Cartesian3()),
        show: false,
        text: entry.name,
        font: "13px system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.TOP,
        pixelOffset: new Cartesian2(0, 6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      renderCard(entry);
      // A hidden model changes nothing on screen, so it must not reframe the camera.
      if (entry.visible) {
        layout();
      }
    });
    model.errorEvent.addEventListener((error: Error) => fail(entry, error));
  } catch (error) {
    fail(entry, error);
  }
}

function fail(entry: Entry, error: unknown): void {
  entry.error = error instanceof Error ? error.message : String(error);
  console.error(`[models] ${entry.path}`, error);
  renderCard(entry);
}

async function measureImages(entry: Entry): Promise<void> {
  const images = entry.stats?.images ?? [];
  await Promise.all(
    images.map(async (image) => {
      if (!image.data) {
        return;
      }
      try {
        const bitmap = await createImageBitmap(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mimeType }));
        image.width = bitmap.width;
        image.height = bitmap.height;
        bitmap.close();
      } catch {
        // Left without dimensions; the card still shows its size.
      }
    }),
  );
  renderCard(entry);
}

/**
 * Rows of bounding spheres, left to right and top to bottom, each centred in a
 * cell sized to it. Origins are wherever they fall: an off-centre origin shows as
 * axes away from the middle of the model, which is what the app would orbit.
 */
function layout(): void {
  const ready = entries.filter((entry) => entry.visible && entry.model && entry.radius !== undefined);
  for (const entry of entries) {
    if (!ready.includes(entry)) {
      hide(entry);
    }
  }
  const mode = controls.scale.value as ScaleMode;
  const columns = Math.max(1, Math.ceil(Math.sqrt(ready.length * 1.6)));
  // Each folder starts a row of its own, so the sets being compared stay apart.
  const rows: Entry[][] = [];
  for (const group of new Set(ready.map((entry) => entry.group))) {
    const members = ready.filter((entry) => entry.group === group);
    for (let i = 0; i < members.length; i += columns) {
      rows.push(members.slice(i, i + columns));
    }
  }

  const scaleOf = (entry: Entry): number => (mode === "fit" ? FIT_RADIUS / entry.radius! : 1);
  const cellOf = (entry: Entry): number => 2 * entry.radius! * scaleOf(entry) * CELL_PADDING;
  const rowHeights = rows.map((row) => Math.max(...row.map(cellOf)));
  let z = rowHeights.reduce((sum, height) => sum + height, 0) / 2;

  rows.forEach((row, r) => {
    const height = rowHeights[r]!;
    let x = -row.reduce((sum, entry) => sum + cellOf(entry), 0) / 2;
    for (const entry of row) {
      const scale = scaleOf(entry);
      const cell = cellOf(entry);
      const middle = new Cartesian3(x + cell / 2, 0, z - height / 2);
      const origin = Cartesian3.subtract(middle, Cartesian3.multiplyByScalar(entry.center!, scale, new Cartesian3()), new Cartesian3());
      const modelMatrix = Matrix4.multiply(ANCHOR, Matrix4.fromTranslation(origin), new Matrix4());

      const model = entry.model!;
      model.modelMatrix = modelMatrix;
      model.scale = scale;
      model.show = true;
      entry.sphere = new BoundingSphere(Matrix4.multiplyByPoint(ANCHOR, middle, new Cartesian3()), entry.radius! * scale);

      if (entry.axes) {
        scene.primitives.remove(entry.axes);
      }
      entry.axes = scene.primitives.add(new DebugModelMatrixPrimitive({ modelMatrix, length: entry.radius! * scale * 1.2, width: 2 })) as DebugModelMatrixPrimitive;
      // Hidden until its model is big enough to be told apart; true scale otherwise stacks the cubesats' labels.
      entry.label!.distanceDisplayCondition = new DistanceDisplayCondition(0, entry.radius! * scale * 300);
      entry.label!.show = true;
      entry.label!.position = Matrix4.multiplyByPoint(ANCHOR, new Cartesian3(middle.x, 0, middle.z - entry.radius! * scale), new Cartesian3());
      x += cell;
    }
    z -= height;
  });

  applyToggles();
  if (entries.every((entry) => !entry.visible || entry.error || entry.radius !== undefined)) {
    const sphere = selected?.sphere ?? allSpheres();
    if (sphere.radius > 0) {
      frame(sphere);
    }
  }
}

function applyToggles(): void {
  for (const entry of entries) {
    if (entry.model) {
      entry.model.debugWireframe = controls.wireframe.checked;
      entry.model.debugShowBoundingVolume = controls.bounds.checked;
      entry.model.silhouetteColor = Color.fromCssColorString("#f5c542");
      entry.model.silhouetteSize = entry === selected ? 2 : 0;
    }
    if (entry.axes) {
      entry.axes.show = controls.axes.checked && entry.visible;
    }
  }
}

function hide(entry: Entry): void {
  entry.sphere = undefined;
  if (entry.model) {
    entry.model.show = false;
  }
  if (entry.axes) {
    entry.axes.show = false;
  }
  if (entry.label) {
    entry.label.show = false;
  }
}

function setVisible(changed: Entry[], visible: boolean): void {
  for (const entry of changed) {
    entry.visible = visible;
    entry.toggle.checked = visible;
    entry.card.hidden = !visible;
  }
  if (selected && !selected.visible) {
    selected.card.classList.remove("selected");
    selected = undefined;
  }
  updatePickerSummary();
  layout();
  writeUrl();
}

function updatePickerSummary(): void {
  for (const [group, heading] of groupHeadings) {
    heading.hidden = !entries.some((entry) => entry.group === group && entry.visible);
  }
  const count = entries.filter((entry) => entry.visible).length;
  controls.picker.querySelector("summary")!.textContent = `Models ${count}/${entries.length}`;
}

function allSpheres(): BoundingSphere {
  return BoundingSphere.fromBoundingSpheres(entries.flatMap((entry) => (entry.sphere ? [entry.sphere] : [])));
}

/** Orbit the sphere: the camera's transform is pinned to it, so dragging turns around it. */
function frame(sphere: BoundingSphere): void {
  const frustum = camera.frustum as PerspectiveFrustum;
  const fovy = frustum.fovy ?? Math.PI / 3;
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * (frustum.aspectRatio || 1));
  const range = (sphere.radius / Math.sin(Math.min(fovx, fovy) / 2)) * 1.05;
  const [heading, pitch] = VIEWS[controls.view.value] ?? VIEWS.starboard!;
  camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(sphere.center), new HeadingPitchRange(heading, pitch, range));
}

function select(entry: Entry | undefined): void {
  selected = entry === selected ? undefined : entry;
  for (const other of entries) {
    other.card.classList.toggle("selected", other === selected);
  }
  if (selected) {
    selected.card.scrollIntoView({ block: "nearest" });
  }
  applyToggles();
  const sphere = selected?.sphere ?? allSpheres();
  if (sphere.radius > 0) {
    frame(sphere);
  }
  writeUrl();
}

function writeUrl(): void {
  const url = new URL(location.href);
  url.searchParams.set("scale", controls.scale.value);
  url.searchParams.set("view", controls.view.value);
  if (selected) {
    url.searchParams.set("model", selected.name);
  } else {
    url.searchParams.delete("model");
  }
  if (entries.every((entry) => entry.visible)) {
    url.searchParams.delete("show");
  } else {
    url.searchParams.set("show", entries.flatMap((entry) => (entry.visible ? [entry.name] : [])).join(","));
  }
  history.replaceState(null, "", url);
}

function renderCard(entry: Entry): void {
  const { stats } = entry;
  const rows: Array<[string, string]> = [];
  if (stats) {
    if (entry.satellites) {
      rows.push([
        "Satellites",
        entry.satellites.length === 0
          ? "none (generic)"
          : entry.satellites.map(({ name, noradId, decayed }) => `${escape(name ?? "")} <span class="path">${noradId}${decayed ? ", decayed" : ""}</span>`).join("<br>"),
      ]);
    }
    rows.push(["File", `${megabytes(stats.fileBytes)} (textures ${megabytes(stats.imageBytes)})`]);
    rows.push(["Triangles", stats.triangles.toLocaleString("en")]);
    rows.push(["Vertices", stats.vertices.toLocaleString("en")]);
    rows.push(["Meshes / nodes", `${stats.meshes} / ${stats.nodes}`]);
    rows.push(["Materials", String(stats.materials)]);
    if (stats.size) {
      // glTF Z, X and Y are what Cesium turns into the velocity, port and zenith.
      const [x, y, z] = stats.size;
      rows.push(["Extent", `${[z, x, y].map(metres).join(" × ")} <span class="path">along × across × radial</span>`]);
    }
    rows.push([
      "Textures",
      stats.images.length === 0
        ? "none"
        : stats.images.map((image) => `${image.width ? `${image.width}×${image.height} ` : ""}${image.mimeType.replace("image/", "")} ${megabytes(image.bytes)}`).join("<br>"),
    ]);
    if (stats.extensions.length) {
      rows.push(["Extensions", stats.extensions.join(", ")]);
    }
    rows.push(["Generator", stats.generator ?? "—"]);
  }
  if (entry.radius !== undefined) {
    rows.push(["Bounding Ø", metres(entry.radius * 2)]);
  }
  const problems = (stats?.problems ?? []).map((problem) => `<div class="error">${escape(problem)}</div>`).join("");
  const status = entry.error ? `<div class="error">${escape(entry.error)}</div>` : stats && entry.radius !== undefined ? "" : `<div class="path">loading…</div>`;
  entry.card.innerHTML = `
    <h2>${escape(entry.name)}</h2>
    <div class="path">${escape(entry.path)}</div>
    ${status}${problems}
    <dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

function megabytes(bytes: number): string {
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function metres(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toPrecision(3)} km`;
  }
  if (value < 1) {
    return `${(value * 100).toPrecision(3)} cm`;
  }
  return `${value.toPrecision(3)} m`;
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

viewer.screenSpaceEventHandler.setInputAction((click: { position: Cartesian2 }) => {
  const picked = scene.pick(click.position) as { primitive?: unknown } | undefined;
  const entry = entries.find((candidate) => candidate.model && candidate.model === picked?.primitive);
  if (entry) {
    select(entry);
  }
}, ScreenSpaceEventType.LEFT_CLICK);

controls.view.addEventListener("change", () => {
  const sphere = selected?.sphere ?? allSpheres();
  if (sphere.radius > 0) {
    frame(sphere);
  }
  writeUrl();
});
controls.scale.addEventListener("change", () => {
  layout();
  writeUrl();
});
for (const toggle of [controls.axes, controls.wireframe, controls.bounds]) {
  toggle.addEventListener("change", applyToggles);
}
controls.all.addEventListener("click", () => select(undefined));
for (const button of controls.picker.querySelectorAll<HTMLButtonElement>("[data-pick]")) {
  button.addEventListener("click", () => setVisible(entries, button.dataset.pick === "all"));
}
document.addEventListener("click", (event) => {
  if (!controls.picker.contains(event.target as Node)) {
    controls.picker.open = false;
  }
});

const initial = params.get("model");
if (initial) {
  selected = entries.find((entry) => entry.name === initial && entry.visible);
  selected?.card.classList.add("selected");
}

// For poking at a model from the console.
Object.assign(window, { modelViewer: { viewer, entries } });
