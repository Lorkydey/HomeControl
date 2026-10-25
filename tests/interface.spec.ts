import { test, expect, type Page } from "@playwright/test";
import { defaultConfig, type AppConfig } from "../shared/config";

async function desktopFixture(
  page: Page,
  paired = true,
  offline: number[] = [],
  config: AppConfig = defaultConfig(),
) {
  await page.addInitScript(
    ({ paired, offline, config }) => {
      const w = window as any;
      const lights = config.lights.map(({ name }, index) => ({
        index,
        name,
        paired,
        online: paired && !offline.includes(index),
        available: false,
        connecting: false,
        on: paired && index !== 2,
        brightness: [70, 45, 25][index],
        temperature: 3000,
        dimmable: true,
        tunable: true,
        minKelvin: 2200,
        maxKelvin: 6500,
        color: true,
        colorMode: index === 1 ? "color" : "white",
        hue: 210,
        saturation: 75,
        hex: "#409fff",
      }));
      const callbacks = new Map<number, (message: any) => void>(),
        listeners = new Map<string, number>();
      let callback = 0;
      w.__emitNative = (name: string) =>
        callbacks.get(listeners.get(name)!)?.({ payload: null });
      w.__requests = [];
      w.__nativeRequests = [];
      w.__delay = 0;
      w.__failNext = false;
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (fn: any) => {
          callbacks.set(++callback, fn);
          return callback;
        },
        invoke: async (command: string, args: any) => {
          if (command === "app_config") return structuredClone(config);
          if (command === "plugin:event|listen") {
            listeners.set(args.event, args.handler);
            return args.handler;
          }
          if (command.startsWith("plugin:event")) return 1;
          if (command !== "engine_request") {
            w.__nativeRequests.push({ command, args });
            if (command === "hide_window")
              callbacks.get(listeners.get("panel-hidden")!)?.({
                payload: null,
              });
            return;
          }
          const { method, params } = args;
          w.__requests.push({ method, params, time: performance.now() });
          if (method !== "status") {
            if (w.__delay)
              await new Promise((resolve) => setTimeout(resolve, w.__delay));
            if (w.__failNext) {
              w.__failNext = false;
              throw Error("Test network failure");
            }
          }
          if (method === "power") lights[params.index].on = params.on;
          if (method === "brightness") {
            lights[params.index].brightness = params.value;
            if (!params.preservePower)
              lights[params.index].on = params.value > 0;
          }
          if (method === "temperature") {
            lights[params.index].temperature = params.value;
            lights[params.index].colorMode = "white";
          }
          if (method === "color") {
            const light = lights[params.index];
            light.hue = params.hue;
            light.saturation = params.saturation;
            light.colorMode = "color";
            if (params.brightness !== undefined) {
              light.brightness = params.brightness;
              light.on = params.brightness > 0;
            }
          }
          if (method === "rename") lights[params.index].name = params.name;
          if (method !== "status")
            callbacks.get(listeners.get("lights-state")!)?.({
              payload: structuredClone(lights),
            });
          return structuredClone(lights);
        },
      };
    },
    { paired, offline, config },
  );
}
const commands = (page: Page, method: string) =>
  page.evaluate(
    (method) =>
      (window as any).__requests.filter((r: any) => r.method === method),
    method,
  );
const requestedHeight = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).__nativeRequests
        .filter((r: any) => r.command === "resize_panel")
        .at(-1)?.args.height,
  );
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("#power-0")).toHaveAttribute(
    "aria-checked",
    "true",
  );
}

test("four horizontal Apple-style bars on deep black, with no permanent status text", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.setViewportSize({ width: 320, height: 280 });
  await ready(page);
  await expect(page.locator(".lamp")).toHaveCount(4);
  await expect(page.locator(".lamp-name")).toHaveText([
    "Toutes les lampes",
    "Chambre",
    "Séjour",
    "Cuisine",
  ]);
  await expect(page.locator("#app")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(
    page.locator("footer,#connection-label,#count,#summary"),
  ).toHaveCount(0);
  await expect(page.locator("#home-view > .lamp").first()).toHaveAttribute(
    "id",
    "light-3",
  );
  await expect(page.locator(".lamp-name").first()).toHaveClass(/sr-only/);
  for (const i of [0, 1, 2])
    await expect(page.locator(`#light-${i} .lamp-name`)).toBeVisible();
  await expect(page.locator("#hide,#settings,header")).toHaveCount(0);
  await expect(page.locator("#light-0 .room-icon")).toHaveAccessibleName(
    "Chambre",
  );
  await expect(page.locator("#light-1 .room-icon")).toHaveAccessibleName(
    "Séjour",
  );
  await expect(page.locator("#light-2 .room-icon")).toHaveAccessibleName(
    "Cuisine",
  );
  await expect(page.locator("#light-3 .color-open")).toBeInViewport({
    ratio: 1,
  });
  await expect(page.locator("#editor")).toBeHidden();
  await expect.poll(() => requestedHeight(page)).toBeLessThanOrEqual(212);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await page.screenshot({
    path: ".preview/bars.png",
    animations: "disabled",
    omitBackground: true,
  });
});

test("bulb icons toggle immediately, keep other bars active and roll back on failure", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.evaluate(() => {
    (window as any).__delay = 600;
  });
  await page.locator("#power-0").click();
  await expect(page.locator("#power-0")).toHaveAttribute(
    "aria-checked",
    "false",
    { timeout: 200 },
  );
  await expect(page.locator("#brightness-0")).toHaveValue("0");
  await expect(page.locator("#power-1")).toBeEnabled();
  await expect(page.locator("#brightness-1")).toBeEnabled();
  await expect(page.locator("#light-0")).toHaveAttribute("aria-busy", "false");
  expect((await commands(page, "power")).map((r: any) => r.params)).toEqual([
    { on: false, index: 0 },
  ]);
  await page.evaluate(() => {
    (window as any).__delay = 80;
    (window as any).__failNext = true;
  });
  await page.locator("#power-0").click();
  await expect(page.locator("#message")).toContainText("Test network failure");
  await expect(page.locator("#power-0")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.locator("#power-1")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("right increases brightness, left decreases it, including keyboard and dragging through the bulb area", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.locator("#brightness-0").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#brightness-0")).toHaveValue("71");
  await expect
    .poll(async () => (await commands(page, "brightness")).at(-1)?.params.value)
    .toBe(71);
  const box = (await page.locator("#brightness-1").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect
    .poll(async () => Number(await page.locator("#brightness-1").inputValue()))
    .toBeGreaterThanOrEqual(70);
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.locator("#brightness-1").inputValue()))
    .toBeLessThanOrEqual(3);
  expect(await commands(page, "power")).toHaveLength(0);
});

test("the fourth bar sets brightness and toggles all three lamps", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.locator("#brightness-3").fill("62");
  await expect
    .poll(
      async () =>
        (await commands(page, "brightness")).filter(
          (r: any) => r.params.value === 62,
        ).length,
    )
    .toBe(3);
  for (const i of [0, 1, 2])
    await expect(page.locator(`#brightness-${i}`)).toHaveValue("62");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  await page.locator("#power-3").click();
  for (const i of [0, 1, 2, 3])
    await expect(page.locator(`#power-${i}`)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  await page.locator("#power-3").click();
  for (const i of [0, 1, 2, 3])
    await expect(page.locator(`#power-${i}`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  await expect.poll(async () => (await commands(page, "power")).length).toBe(6);
});

test("global RGB/HEX and white apply to all lamps, individual palettes affect only their lamp", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.locator("#color-open-3").click();
  await expect(page.locator("#editor-name")).toHaveText("Toutes les lampes");
  await expect(page.locator("#home-view")).toBeHidden();
  await page.locator("[data-mode=color]").click();
  await page.locator("#hex").fill("#40a0ff");
  await page.locator("#hex").dispatchEvent("change");
  await expect
    .poll(async () =>
      (await commands(page, "color"))
        .filter((r: any) => r.params.brightness === 100)
        .map((r: any) => r.params.index)
        .sort(),
    )
    .toEqual([0, 1, 2]);
  for (const r of (await commands(page, "color")).filter(
    (r: any) => r.params.brightness === 100,
  ))
    expect(r.params).toMatchObject({
      hue: 210,
      saturation: 75,
      brightness: 100,
    });
  await page.locator("[data-mode=white]").click();
  await page.locator('[data-white="4000"]').click();
  await expect
    .poll(
      async () =>
        (await commands(page, "temperature")).filter(
          (r: any) => r.params.value === 4000,
        ).length,
    )
    .toBe(3);
  await page.locator("#editor-close").click();
  await page.locator("#color-open-1").click();
  await page.locator("[data-mode=color]").click();
  const before = (await commands(page, "color")).length;
  await page.getByRole("button", { name: "Rouge", exact: true }).click();
  await expect
    .poll(async () => (await commands(page, "color")).length)
    .toBeGreaterThan(before);
  expect((await commands(page, "color")).at(-1).params).toMatchObject({
    index: 1,
    hue: 0,
    saturation: 72,
  });
  await page.locator("#hue").fill("280");
  await page.locator("#hue").dispatchEvent("change");
  await page.locator("#saturation").fill("35");
  await page.locator("#saturation").dispatchEvent("change");
  await expect
    .poll(async () => (await commands(page, "color")).at(-1).params)
    .toMatchObject({ index: 1, hue: 280, saturation: 35 });
  await page.screenshot({
    path: ".preview/bars-color.png",
    animations: "disabled",
    omitBackground: true,
  });
  await expect(page.locator("#saturation")).toBeInViewport({ ratio: 1 });
});

test("offline lamps are excluded from group commands and names remain editable", async ({
  page,
}) => {
  await desktopFixture(page, true, [2]);
  await ready(page);
  await expect(page.locator("#power-2")).toBeDisabled();
  await expect(page.locator("#brightness-2")).toBeDisabled();
  await expect(page.locator("#color-open-2")).toBeDisabled();
  await page.locator("#brightness-3").fill("55");
  await expect
    .poll(async () =>
      (await commands(page, "brightness"))
        .map((r: any) => r.params.index)
        .sort(),
    )
    .toEqual([0, 1]);
  await page.evaluate(() => (window as any).__emitNative("open-settings"));
  await page.locator("#name-0").fill("Lampe du bureau");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.locator("#light-0 .lamp-name")).toHaveText(
    "Lampe du bureau",
  );
  await expect(page.locator("#power-0")).toHaveAccessibleName(
    "Éteindre Lampe du bureau",
  );
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
});

test("rapid global brightness gestures keep only the latest queued value per lamp", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.evaluate(() => {
    (window as any).__delay = 150;
  });
  await page.locator("#brightness-3").evaluate((input: HTMLInputElement) => {
    for (let value = 10; value <= 90; value++) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const i of [0, 1, 2])
    await expect(page.locator(`#brightness-${i}`)).toHaveValue("90");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  const requests = await commands(page, "brightness");
  for (const i of [0, 1, 2]) {
    const lane = requests.filter((r: any) => r.params.index === i);
    expect(lane.length).toBeLessThanOrEqual(2);
    expect(lane.at(-1).params.value).toBe(90);
  }
});

test("pairing is available from an unpaired bulb icon with focus restored on Escape", async ({
  page,
}) => {
  await desktopFixture(page, false);
  await page.goto("/");
  await expect(page.locator("#power-3")).toBeDisabled();
  await page
    .getByRole("button", { name: "Appairer Chambre", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Appairer Chambre" }),
  ).toBeVisible();
  await expect(page.locator("#pair-code")).toBeFocused();
  await expect.poll(() => requestedHeight(page)).toBeGreaterThan(250);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  await expect(page.locator("#pair-submit")).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#pair-dialog")).toBeHidden();
  await expect(page.locator("#power-0")).toBeFocused();
});

test("color replaces the lamps with a right-hand page, back restores focus and settings fit", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.setViewportSize({ width: 320, height: 280 });
  await ready(page);
  await page.locator("#color-open-0").click();
  await expect(page.locator("#home-view")).toBeHidden();
  await expect(page.locator("#home-view")).toHaveJSProperty("inert", true);
  await expect(page.locator("#settings,#hide,header")).toHaveCount(0);
  await expect(page.locator("#editor-room")).toHaveAccessibleName("Chambre");
  await expect.poll(() => requestedHeight(page)).toBeLessThanOrEqual(280);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  await expect(page.locator(".white-presets")).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#home-view")).toBeVisible();
  await expect(page.locator("#color-open-0")).toBeFocused();
  await expect.poll(() => requestedHeight(page)).toBeLessThanOrEqual(280);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  await page.evaluate(() => (window as any).__emitNative("open-settings"));
  await expect.poll(() => requestedHeight(page)).toBeGreaterThan(300);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  await expect(page.locator("#names-form .primary-button")).toBeInViewport({
    ratio: 1,
  });
  await page.locator(".settings-close").click();
  await expect.poll(() => requestedHeight(page)).toBeLessThanOrEqual(280);
});

test("animated fills stay anchored left, reverse smoothly and never delay commands", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await expect(page.locator("#app")).toHaveClass(/motion-ready/);
  const progress = () =>
    page
      .locator("#light-0 .bar-fill")
      .evaluate(
        (element) =>
          new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
      );
  await expect.poll(progress).toBeCloseTo(0.7, 2);
  await page.locator("#power-0").click();
  await expect
    .poll(async () => (await commands(page, "power")).at(-1)?.params.on)
    .toBe(false);
  await expect.poll(progress).toBeLessThan(0.695);
  await page.locator("#light-0 .bar-fill").evaluate((element) => {
    for (const animation of element.getAnimations())
      animation.playbackRate = 0.1;
  });
  const start = await progress();
  expect(start).toBeGreaterThan(0);
  expect(start).toBeLessThan(0.7);
  await page.waitForTimeout(80);
  const midway = await progress();
  expect(midway).toBeGreaterThan(0);
  expect(midway).toBeLessThan(start);
  const geometry = await page
    .locator("#light-0 .brightness-shell")
    .evaluate((shell) => ({
      shellLeft: shell.getBoundingClientRect().left,
      fillLeft: shell.querySelector(".bar-fill")!.getBoundingClientRect().left,
    }));
  expect(Math.abs(geometry.shellLeft - geometry.fillLeft)).toBeLessThan(1);
  await page.screenshot({
    path: ".preview/motion-slow.png",
    animations: "allow",
    omitBackground: true,
  });
  const reversal = await page
    .locator("#light-0 .bar-fill")
    .evaluate((element) => {
      const before = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        .a;
      document.querySelector<HTMLButtonElement>("#power-0")!.click();
      return {
        before,
        after: new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
      };
    });
  expect(Math.abs(reversal.after - reversal.before)).toBeLessThan(0.02);
  await expect(page.locator("#power-0")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect.poll(progress).toBeCloseTo(0.7, 2);
  expect((await commands(page, "power")).map((r: any) => r.params.on)).toEqual([
    false,
    true,
  ]);
});

test("the color page slides in from the right and can reverse without a late close or resize flood", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.locator("#color-open-0").click();
  await expect(page.locator("#editor")).toHaveAttribute("aria-hidden", "false");
  await page.waitForTimeout(80);
  const first = await page.locator("#editor").evaluate((element) => ({
    x: new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
    width: element.getBoundingClientRect().width,
  }));
  expect(first.x).toBeGreaterThan(0);
  expect(first.x).toBeLessThan(first.width);
  await page.locator("#editor-close").dispatchEvent("click");
  await page.waitForTimeout(35);
  await page.locator("#color-open-0").dispatchEvent("click");
  await expect(page.locator("#editor")).toHaveAttribute("aria-hidden", "false");
  await expect
    .poll(() =>
      page
        .locator("#editor")
        .evaluate((element) =>
          Math.abs(
            new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
          ),
        ),
    )
    .toBeLessThan(1);
  await page.waitForTimeout(350);
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#home-view")).toBeHidden();
  await expect.poll(() => requestedHeight(page)).toBeLessThanOrEqual(280);
  const resizeRequests = await page.evaluate(
    () =>
      (window as any).__nativeRequests.filter(
        (r: any) => r.command === "resize_panel",
      ).length,
  );
  expect(resizeRequests).toBeLessThanOrEqual(6);
});

test("reduced-motion preference keeps the same controls with immediate visual state changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await desktopFixture(page);
  await ready(page);
  await expect(page.locator("#light-0 .bar-fill")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await page.locator("#brightness-0").fill("45");
  const progress = await page
    .locator("#light-0 .bar-fill")
    .evaluate(
      (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
    );
  expect(progress).toBeCloseTo(0.45, 2);
  await page.locator("#color-open-0").click();
  await expect(page.locator("#editor")).toHaveCSS("transition-duration", "0s");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor")).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    ),
  ).toBe(0);
});

test("individual dimming never lowers the independent master control and its setting survives reload", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await expect(page.locator("#brightness-3")).toHaveValue("100");
  await page.locator("#brightness-0").fill("30");
  await expect(page.locator("#light-0")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#brightness-3")).toHaveValue("100");
  expect(
    (await commands(page, "brightness")).map((r: any) => r.params.index),
  ).toEqual([0]);
  await page.locator("#brightness-3").fill("74");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  await page.locator("#brightness-1").fill("10");
  await expect(page.locator("#light-1")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#brightness-3")).toHaveValue("74");
  await expect(page.locator("#brightness-0")).toHaveValue("74");
  await expect(page.locator("#brightness-2")).toHaveValue("74");
  await page.reload();
  await expect(page.locator("#power-0")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#brightness-3")).toHaveValue("74");
});

test("turning the master back on after zero restores its last nonzero global level", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.locator("#brightness-3").fill("58");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  await page.locator("#brightness-3").fill("0");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#power-3")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.locator("#power-3").click();
  for (const index of [0, 1, 2, 3])
    await expect(page.locator(`#brightness-${index}`)).toHaveValue("58");
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  for (const index of [0, 1, 2])
    expect(
      (await commands(page, "brightness"))
        .filter((r: any) => r.params.index === index)
        .at(-1).params.value,
    ).toBe(58);
});

test("global bar uses the full row and room names remain visible without hover tooltips", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.setViewportSize({ width: 320, height: 280 });
  await ready(page);
  await expect(page.locator(".all-label")).toHaveCount(0);
  await expect(page.locator("#light-3 .room-icon")).toBeHidden();
  const globalBar = (await page
    .locator("#light-3 .brightness-shell")
    .boundingBox())!;
  const globalRow = (await page.locator("#light-3").boundingBox())!;
  const roomBar = (await page
    .locator("#light-0 .brightness-shell")
    .boundingBox())!;
  expect(globalBar.x).toBe(globalRow.x);
  expect(globalBar.width).toBeGreaterThan(roomBar.width + 40);
  await expect(page.locator("#light-3 .room-icon svg")).toHaveCount(0);
  for (const [index, name] of ["Chambre", "Séjour", "Cuisine"].entries()) {
    await page.locator(`#light-${index} .room-icon`).hover();
    await expect(page.locator(`#light-${index} .lamp-name`)).toHaveText(name);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await expect(page.locator("[title]")).toHaveCount(0);
  await page.screenshot({
    path: ".preview/wider-panel.png",
    animations: "disabled",
    omitBackground: true,
  });
  await page.mouse.move(0, 0);
  await page.locator("#color-open-3").click();
  await expect(page.locator("#editor-room")).toBeHidden();
  await expect(page.locator("#editor-name")).toHaveText("Toutes les lampes");
  await expect(page.locator("#selected-room-icon svg")).toHaveCount(0);
});

test("keyboard controls keep accessible names and Escape dismisses without a tooltip step", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.keyboard.press("Tab");
  await page.locator("#brightness-0").focus();
  await expect(page.locator("#brightness-0")).toHaveAccessibleName(
    "Luminosit\u00e9 de Chambre",
  );
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__nativeRequests.filter(
            (r: any) => r.command === "hide_window",
          ).length,
      ),
    )
    .toBe(1);
});

test("individual power stays isolated and mixed ALL turns on only the missing lamps", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await expect(page.locator("#power-3")).toHaveAttribute(
    "aria-checked",
    "mixed",
  );
  await page.locator("#power-0").click();
  await expect(page.locator("#light-0")).toHaveAttribute("aria-busy", "false");
  expect((await commands(page, "power")).map((r: any) => r.params)).toEqual([
    { index: 0, on: false },
  ]);
  await expect(page.locator("#power-1")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#brightness-1")).toHaveValue("45");
  await expect(page.locator("#brightness-3")).toHaveValue("100");
  await page.locator("#power-3").click();
  await expect(page.locator("#power-3")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#light-3")).toHaveAttribute("aria-busy", "false");
  expect(
    (await commands(page, "power"))
      .slice(1)
      .map((r: any) => r.params)
      .sort((a: any, b: any) => a.index - b.index),
  ).toEqual([
    { index: 0, on: true },
    { index: 2, on: true },
  ]);
  await expect(page.locator("#brightness-1")).toHaveValue("45");
});

test("caption sits below each icon and dismissal resets the color page without disconnecting", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  for (const index of [0, 1, 2]) {
    const icon = (await page
      .locator(`#light-${index} .room-icon svg`)
      .boundingBox())!;
    const name = (await page
      .locator(`#light-${index} .lamp-name`)
      .boundingBox())!;
    expect(name.y).toBeGreaterThanOrEqual(icon.y + icon.height);
  }
  await page.locator("#color-open-1").click();
  await page.evaluate(() => (window as any).__emitNative("panel-hidden"));
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#home-view")).toBeVisible();
  await page.evaluate(() => (window as any).__emitNative("panel-shown"));
  await expect(page.locator("#power-1")).toBeEnabled();
  expect(await commands(page, "status")).toHaveLength(1);
});

test("scrubbing follows the held pointer, releases outside the bar and resets when hidden", async ({
  page,
}) => {
  await desktopFixture(page);
  await ready(page);
  await page.setViewportSize({
    width: 320,
    height: await requestedHeight(page),
  });
  const box = (await page.locator("#brightness-1").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height / 2, {
    steps: 8,
  });
  await expect(page.locator(".scrubbing")).toHaveCount(1);
  await expect(page.locator("#light-1")).toHaveClass(/scrubbing/);
  await expect(page.locator("#light-1 .bar-readout")).toHaveText(
    `${await page.locator("#brightness-1").inputValue()} %`,
  );
  await expect(page.locator("#light-1 .bar-sheen")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: ".preview/drag-active.png",
    animations: "allow",
    omitBackground: true,
  });
  await page.mouse.move(box.x + box.width * 0.82, box.y + 65);
  await page.mouse.up();
  await expect(page.locator(".scrubbing,.dragging")).toHaveCount(0);
  await expect(page.locator("#light-1 .bar-readout")).toHaveCSS("opacity", "0");
  await expect(page.locator("#light-1")).toHaveAttribute("aria-busy", "false");
  const level = Number(await page.locator("#brightness-1").inputValue());
  expect((await commands(page, "brightness")).at(-1).params).toMatchObject({
    index: 1,
    value: level,
  });
  expect(
    (await commands(page, "brightness")).every(
      (r: any) => r.params.index === 1,
    ),
  ).toBe(true);
  await page.locator("#brightness-0").focus();
  await page.keyboard.down("ArrowRight");
  await expect(page.locator("#light-0")).toHaveClass(/scrubbing/);
  await page.evaluate(() => (window as any).__emitNative("panel-hidden"));
  await page.keyboard.up("ArrowRight");
  await expect(page.locator(".scrubbing,.dragging")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.locator("#color-open-0").hover();
  await page.screenshot({
    path: ".preview/color-lens.png",
    animations: "disabled",
    omitBackground: true,
  });
});

test("custom slot counts, icons and names use stable per-slot controls without rendering markup", async ({
  page,
}) => {
  const config = defaultConfig();
  config.lights = [
    { id: "office", name: '<img src=x onerror="bad()">', icon: "desk" },
    { id: "reading", name: "Reading", icon: "sun" },
  ];
  await desktopFixture(page, true, [], config);
  await ready(page);
  await expect(page.locator(".lamp")).toHaveCount(3);
  await expect(page.locator("#light-0 .lamp-name")).toHaveText(
    config.lights[0].name,
  );
  await expect(page.locator("#app img")).toHaveCount(0);
  await expect(page.locator("#light-2 .room-icon")).toBeHidden();
  await page.locator("#brightness-2").fill("64");
  await expect(page.locator("#light-2")).toHaveAttribute("aria-busy", "false");
  expect(
    (await commands(page, "brightness")).map((r: any) => r.params.index).sort(),
  ).toEqual([0, 1]);
  await page.locator("#power-0").click();
  await expect(page.locator("#power-1")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.locator("#color-open-2").click();
  await expect(page.locator("#editor-name")).toHaveText("Toutes les lampes");
});
