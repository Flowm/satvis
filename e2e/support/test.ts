// The `test` every spec imports: Playwright's, plus a check that the page logged no
// console error. A spec that expects some sets `allowConsoleErrors` to a pattern; one
// that opens pages of its own collects their errors with `collectConsoleErrors`.

import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/** Every console error and uncaught exception `page` reports from now on, unless it matches `allow`. */
export function collectConsoleErrors(page: Page, allow?: RegExp): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !allow?.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

// A single pattern, not a list: `test.use` reads an array as a [value, options] pair.
export const test = base.extend<{ allowConsoleErrors: RegExp | undefined; consoleErrors: string[] }>({
  allowConsoleErrors: [undefined, { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors = collectConsoleErrors(page, allowConsoleErrors);
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});
