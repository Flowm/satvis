// The `test` every spec imports: Playwright's, plus a check that the page logged no
// console error. A spec that expects some sets `allowConsoleErrors`.

import { test as base, expect } from "@playwright/test";

export { expect };

export const test = base.extend<{ allowConsoleErrors: RegExp[]; consoleErrors: string[] }>({
  allowConsoleErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && !allowConsoleErrors.some((pattern) => pattern.test(message.text()))) {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});
