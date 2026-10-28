import { test, expect } from "./source-fixture.mjs";

const runtimeSwitch = (page) =>
  page.getByRole("switch", { name: "Watching for Ada on this device" });

// Real browser focus and scroll geometry are outside jsdom.
test("The watching page fits both themes and sizes and manages existing watches by keyboard", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const pane = page.getByRole("region", {
    name: "What your agents are watching",
    exact: true,
  });
  await expect(page.getByRole("button", { name: "New watch" })).toHaveCount(0);
  await expect(pane).toBeVisible();
  await page
    .getByRole("button", { name: "Details for Release discussion" })
    .click();
  await expect(page.getByText(/The release is ready for review/)).toBeVisible();
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(runtimeSwitch(page)).toBeInViewport();
      await expect(
        page.getByRole("switch", { name: "Watch Release discussion" }),
      ).toBeInViewport();
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
  const runtime = page.getByRole("switch", {
    name: "Watching for Ada on this device",
  });
  await runtime.focus();
  await page.keyboard.press("Space");
  await expect(runtime).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Watching paused on this device")).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Watch Release discussion" }),
  ).toBeVisible();
  await page.keyboard.press("Space");
  await expect(runtime).toHaveAttribute("aria-checked", "true");
  const toggle = page.getByRole("switch", {
    name: "Watch example/project#42",
  });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const details = page.getByRole("button", {
    name: "Details for example/project#42",
  });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("link", { name: "Open project#42" }),
  ).toHaveAttribute("href", "https://github.com/example/project/pull/42");
});

// Browser focus after removal, including async writes, cannot be proved by jsdom.
test("watch and interest deletion restore focus without taking it from another control", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const pane = page.getByRole("region", {
    name: "What your agents are watching",
    exact: true,
  });
  const remove = page.getByRole("button", {
    name: "Delete Release discussion",
  });
  await page.mouse.move(1, 1);
  await expect(remove.locator("..")).toHaveCSS("opacity", "0");
  await remove.locator("xpath=ancestor::li").hover();
  await expect(remove.locator("..")).toHaveCSS("opacity", "1");
  await page.mouse.move(1, 1);
  await page.getByRole("switch", { name: "Watch Release discussion" }).focus();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await page.evaluate(() => window.attentionFixture.holdSave());
  await remove.focus();
  await expect(remove.locator("..")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(remove).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(remove).toHaveCount(0);
  await expect(pane).toBeFocused();
  const interest = page.getByRole("region", {
    name: "Interest Release planning",
    exact: true,
  });
  await expect(interest).toBeVisible();
  const removeInterest = page.getByRole("button", {
    name: "Delete Interest Release planning",
  });
  await expect(removeInterest).toHaveText("");
  await expect(removeInterest.locator("..")).toHaveCSS("opacity", "0");
  await page.evaluate(() => window.attentionFixture.holdSave());
  await removeInterest.focus();
  await expect(removeInterest.locator("..")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(removeInterest).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(interest).toHaveCount(0);
  await expect(pane).toBeFocused();

  await page.reload();
  await page.evaluate(() => window.attentionFixture.holdSave());
  await remove.focus();
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await page
      .getByRole("switch", { name: "Watching for Ada on this device" })
      .focus();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Watching for Ada on this device" }),
  ).toBeFocused();
});

// Hover media behavior and tap activation require a real touch browser context.
test.describe("touch delete actions", () => {
  test.use({ hasTouch: true });
  test("keeps watch and Interest deletion available without hover", async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/agent-attention.html");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const remove = page.getByRole("button", {
      name: "Delete Release discussion",
    });
    await expect(remove.locator("..")).toHaveCSS("opacity", "1");
    await remove.tap();
    await expect(remove).toHaveCount(0);
    const interest = page.getByRole("button", {
      name: "Delete Interest Release planning",
    });
    await expect(interest.locator("..")).toHaveCSS("opacity", "1");
    await interest.tap();
    await expect(interest).toHaveCount(0);
  });
});
