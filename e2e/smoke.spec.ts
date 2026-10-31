// One smoke path through the judge click-path (README), in fixture mode.

import { expect, test } from "@playwright/test";

test("preset → plan → evidence → comp swap → brief", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Find the audience your release can actually reach/ })).toBeVisible();
  await expect(page.getByText("Synthetic data — not Qloo").first()).toBeVisible();

  // Preset resolves comps, then the trust step.
  await page.getByRole("button", { name: /Prestige horror film/ }).click();
  await expect(page.getByRole("heading", { name: "Confirm your comps" })).toBeVisible();
  await expect(page.getByText("You typed “Midsommar”")).toBeVisible();
  await page.getByRole("button", { name: "Plan campaign" }).click();

  // Results: three concepts, one recommended, disclaimer present.
  await expect(page.getByRole("heading", { name: "“The Tithe”", level: 1 })).toBeVisible();
  await expect(page.getByText("Recommended", { exact: true })).toHaveCount(1);
  for (const lever of ["Market-led", "Partner-led", "Crossover"]) await expect(page.getByText(lever, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/not a forecast of box office/).first()).toBeVisible();
  // Exclusion "alcohol" removed the synthetic alcohol brands.
  await expect(page.getByText(/removed \d+ partner candidate/)).toBeVisible();
  const conceptsText = await page.locator("main, body").innerText();
  expect(conceptsText).not.toContain("Hollowbrook Cider");

  // Evidence drawer shows the request behind a fact; Escape closes it.
  await page.getByRole("button", { name: /^Open evidence F\d+$/ }).first().click();
  const drawer = page.getByRole("dialog", { name: "Evidence" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/GET \/v2\/insights/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // Comp swap (pre-filled Midsommar → Lady Bird) re-plans and shows an attributable diff.
  await page.getByRole("button", { name: "Swap comp" }).click();
  await expect(page.getByLabel("New comp")).toHaveValue("Lady Bird");
  await page.getByRole("button", { name: "Re-plan" }).click();
  await expect(page.getByText("Comp swapped — the plan changed")).toBeVisible();
  await expect(page.getByText(/Lady Bird/).first()).toBeVisible();
  await page.getByRole("button", { name: "What moved?" }).click();
  await expect(page.getByText("New in the plan")).toBeVisible();

  // A second swap must target a comp that is still in the plan (not the one just replaced).
  await page.getByRole("button", { name: "Swap comp" }).click();
  const replace = page.getByLabel("Comp to replace");
  const selected = await replace.inputValue();
  const options = await replace.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options).toContain(selected);
  await expect(replace.locator("option:checked")).not.toHaveText("Midsommar");
  await page.getByLabel("New comp").fill("Booksmart");
  await page.getByRole("button", { name: "Re-plan" }).click();
  await expect(page.getByText(/Booksmart/).first()).toBeVisible();

  // Audience map and advanced scoring drawer.
  await page.getByRole("tab", { name: "Audience map" }).click();
  await expect(page.getByText("One audience or two?")).toBeVisible();
  await page.getByText("Advanced: how scores are computed").click();
  await expect(page.getByText(/score = \(1\/\|C\|\)/)).toBeVisible();

  // Without Qloo: no LLM configured in the smoke env, so it must say so rather than fake it.
  await page.getByRole("tab", { name: "Without Qloo" }).click();
  await page.getByRole("button", { name: "Show without Qloo" }).click();
  await expect(page.getByText(/Baseline unavailable/)).toBeVisible();
  // A comp swap made from this tab clears the previous comps' baseline.
  await page.getByRole("button", { name: "Swap comp" }).click();
  await page.getByLabel("New comp").fill("Eighth Grade");
  await page.getByRole("button", { name: "Re-plan" }).click();
  await expect(page.getByText(/Eighth Grade/).first()).toBeVisible();
  await expect(page.getByText(/Baseline unavailable/)).toBeHidden();
  await expect(page.getByRole("button", { name: "Show without Qloo" })).toBeVisible();

  // Decision brief, templated and labelled.
  await page.getByRole("tab", { name: "Decision brief" }).click();
  await expect(page.getByText("Generated without the writing model")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / PDF" })).toBeVisible();

  // No horizontal page scroll at this viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("made-up comp shows the not-found path before spending research calls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Plan my own release" }).click();
  await page.getByLabel("Release title").fill("Test Release");
  await page.getByLabel("Comp 1").fill("Hereditary");
  await page.getByLabel("Comp 2").fill("Notarealtitle Asdf");
  await page.getByRole("button", { name: "Find comps" }).click();
  await expect(page.getByText(/couldn't find “Notarealtitle Asdf” in Qloo/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Plan campaign" })).toBeDisabled();
  await expect(page.getByText("Need at least 2 confirmed comps.")).toBeVisible();
});
