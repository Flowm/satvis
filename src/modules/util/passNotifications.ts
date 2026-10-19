// Pass reminders. Not on CesiumController: nothing here needs the globe.

import dayjs from "dayjs";

import type { Pass } from "../PassPredictor";
import { PushManager } from "./PushManager";

/** One per page, so its duplicate check spans every panel that asks. */
const pushManager = new PushManager();

/** Two reminders for each pass: `aheadMin` minutes before it starts, and as it starts. */
export function notifyPasses(passes: readonly Pass[], aheadMin = 5): void {
  for (const pass of passes) {
    const start = dayjs(pass.start).startOf("second");
    pushManager.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
    pushManager.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
  }
}
