// The deployed config, which scripts/generate-groups.mjs merged and validated.

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import type { GroupsConfig } from "./types.ts";

/**
 * Typed through `unknown`: a json import types an array as the union of its literals, each
 * missing the others' keys, which no index signature (a featured bookmark's query) overlaps.
 */
export const groupsConfig = generatedConfig as unknown as GroupsConfig;
