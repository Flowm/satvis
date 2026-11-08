// The benchmark scenes of the core config's presets (ADR 0016), against the url codec, which the
// worker does not have.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPinia, setActivePinia } from "pinia";
import { expect, test } from "vitest";
import { createApp } from "vue";
import { parse } from "yaml";

import { type FieldSpec, paramOf } from "@/modules/util/urlCodec";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

interface CorePreset {
  name: string;
  benchmark?: { id: string; query?: Record<string, string> }[];
}

const path = fileURLToPath(new URL("../../worker/src/config/satvis.core.yaml", import.meta.url));
const scenes = (parse(readFileSync(path, "utf8")) as { presets: CorePreset[] }).presets.flatMap((preset) => preset.benchmark ?? []);

test("the default preset lists scenes, every other preset is served them", () => {
  expect(scenes.length).toBeGreaterThan(0);
});

test("every benchmark scene's query reads back as written", () => {
  const schema: FieldSpec[] = [];
  const pinia = createPinia();
  pinia.use(({ options }) => void schema.push(...(options.urlsync?.config ?? [])));
  // Pinia installs plugins only once it has an app.
  createApp({}).use(pinia);
  setActivePinia(pinia);
  useSatStore();
  useCesiumStore();
  const byParam = new Map(schema.map((spec) => [paramOf(spec), spec.kind]));

  for (const scene of scenes) {
    for (const [param, raw] of Object.entries(scene.query ?? {})) {
      const kind = byParam.get(param);
      expect(kind, `${scene.id}: ${param}`).toBeDefined();
      const parsed = kind!.parse(raw);
      expect(parsed.ok && kind!.format(parsed.value), `${scene.id}: ${param}`).toEqual({ ok: true, value: raw });
    }
  }
});
