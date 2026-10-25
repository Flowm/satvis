import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu } from "../support/ui";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/gp/", import.meta.url));

interface FixtureRecord {
  NORAD_CAT_ID: number;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  metadata?: { category?: string };
}

/** orbitClassOf's LEO: a period of at most 128 min, not highly elliptical. */
const isLeo = (record: FixtureRecord) => record.ECCENTRICITY <= 0.25 && 1440 / record.MEAN_MOTION <= 128;

/** The fixture's records, one per satnum, as the catalog lists them. */
function fixtureSatellites(): FixtureRecord[] {
  const bySatnum = new Map<number, FixtureRecord>();
  for (const file of readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json") && name !== "groups.json")) {
    for (const record of JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, "utf8")) as FixtureRecord[]) {
      bySatnum.set(record.NORAD_CAT_ID, record);
    }
  }
  return [...bySatnum.values()];
}

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("the catalog filters every satellite and shows the matches on the globe", async ({ page }) => {
      await openApp(page, "");
      await openMenu(page, "Satellites");
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();

      const sheet = page.getByRole("region", { name: "Satellite catalog" });
      await expect(sheet).toBeVisible();
      // The sheet takes the panel's place.
      await expect(page.getByRole("region", { name: "Satellites" })).toBeHidden();

      const all = fixtureSatellites();
      await expect(sheet.locator(".catalogSheet__of")).toHaveText(`of ${all.length}`);

      // Purpose counts under every other filter, so a pick narrows the count to its satellites.
      const isMeteorology = (record: FixtureRecord) => record.metadata?.category?.split("/").some((code) => code.replace(/[?*]+$/, "") === "MET") ?? false;
      const meteorology = all.filter(isMeteorology).length;
      const pickMeteorology = () => sheet.getByRole("button", { name: /^Meteorology\b/ }).click();
      await pickMeteorology();
      await expect(sheet.locator(".catalogSheet__count")).toHaveText(String(meteorology));
      await expect(sheet.locator(".cs-chip")).toHaveText(["Purpose Meteorology"]);

      // LEO picks every LEO kind, not only the ones the weather satellites leave visible, so
      // dropping the purpose keeps all of LEO picked under one chip.
      await sheet.getByRole("button", { name: /^LEO\s/ }).click();
      await expect(sheet.locator(".catalogSheet__count")).toHaveText(String(all.filter((record) => isMeteorology(record) && isLeo(record)).length));
      await expect(sheet.locator(".cs-chip")).toHaveText(["Orbit LEO", "Purpose Meteorology"]);
      await sheet.getByRole("button", { name: "Remove the filter Purpose Meteorology" }).click();
      await expect(sheet.locator(".cs-chip")).toHaveText(["Orbit LEO"]);
      await expect(sheet.locator(".catalogSheet__count")).toHaveText(String(all.filter(isLeo).length));
      await sheet.getByRole("button", { name: "Remove the filter Orbit LEO" }).click();
      await pickMeteorology();
      await expect(sheet.locator(".catalogSheet__count")).toHaveText(String(meteorology));

      // A phone shows the list on its own tab.
      if (device === "phone") {
        await sheet.getByRole("tab", { name: /Satellites/ }).click();
      }
      await sheet.getByRole("button", { name: "Show only these" }).click();
      const sats = new URL(page.url()).searchParams.get("sats")?.split(",") ?? [];
      expect(sats).toHaveLength(meteorology);
      expect(new URL(page.url()).searchParams.get("tags")).toBe("");
      await expect.poll(() => page.evaluate(() => window.cc!.sats.activeSatellites.length)).toBe(meteorology);
      await expect(sheet.getByRole("button", { name: /on the globe/ })).toHaveText(`${meteorology} on the globe`);

      // The grip drags: up past the threshold expands, down shrinks. The pointer leaves the
      // header on the first move, so this fails if the drag is only followed on the header.
      const dragGrip = async (dy: number) => {
        // The sheet eases to its new size for 0.3 s; read before then, the grip is where the
        // last drag let go, and the press lands in the sheet's body.
        await sheet.evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
        const grip = (await sheet.locator(".catalogSheet__grip").boundingBox())!;
        const x = grip.x + grip.width / 2;
        const y = grip.y + grip.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + dy, { steps: 4 });
        await page.mouse.up();
      };
      await dragGrip(-150);
      await expect(sheet).toHaveClass(/catalogSheet--full/);
      await dragGrip(150);
      await expect(sheet).not.toHaveClass(/catalogSheet--full/);

      // Full screen, then a tile opened in place; Escape closes them innermost first.
      await sheet.getByRole("button", { name: "Expand to full screen" }).first().click();
      await expect(sheet).toHaveClass(/catalogSheet--full/);
      if (device === "phone") {
        await sheet.getByRole("tab", { name: /Filters/ }).click();
      }
      await sheet.getByRole("button", { name: "Open Country large" }).click();
      await expect(sheet.getByRole("textbox", { name: "Find country" })).toBeVisible();
      await sheet.getByRole("textbox", { name: "Find country" }).blur();
      await page.keyboard.press("Escape");
      await expect(sheet.getByRole("textbox", { name: "Find country" })).toBeHidden();
      await expect(sheet).toHaveClass(/catalogSheet--full/);
      await page.keyboard.press("Escape");
      await expect(sheet).not.toHaveClass(/catalogSheet--full/);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(page.getByRole("region", { name: "Satellites" })).toBeVisible();

      // Another menu panel opens over the sheet, which stays; Escape closes the panel first.
      // The Satellites entry takes the sheet back to its panel.
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();
      await expect(sheet).toBeVisible();
      await openMenu(page, "Map");
      await expect(page.getByRole("region", { name: "Map" })).toBeVisible();
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("region", { name: "Map" })).toBeHidden();
      await expect(sheet).toBeVisible();
      await openMenu(page, "Satellites");
      await expect(sheet).toBeHidden();
      await expect(page.getByRole("region", { name: "Satellites" })).toBeVisible();

      // Dragged down from the sheet, it closes, as the close button does.
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();
      await expect(sheet).toBeVisible();
      await dragGrip(150);
      await expect(sheet).toBeHidden();
      await expect(page.getByRole("region", { name: "Satellites" })).toBeHidden();
    });
  });
}
