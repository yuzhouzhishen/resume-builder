import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LAYOUT_SETTINGS,
  buildLayoutCandidates,
  cssVariablesForLayout,
  publicLayoutCandidate,
  resolveLayoutSettings,
  spacingVariables,
  validateLayoutSettings
} from "./layout-settings.mjs";

test("layout settings resolve backward-compatible defaults", () => {
  assert.deepEqual(resolveLayoutSettings({}), DEFAULT_LAYOUT_SETTINGS);
});

test("layout settings accept bounded values", () => {
  assert.deepEqual(validateLayoutSettings({
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  }), {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  });
});

test("layout settings reject unknown keys and invalid enums", () => {
  assert.throws(
    () => validateLayoutSettings({ color: "blue" }),
    /Unknown layout setting: color/
  );
  assert.throws(
    () => validateLayoutSettings({ mode: "fluid" }),
    /layout.mode must be auto or fixed/
  );
  assert.throws(
    () => validateLayoutSettings({ marginPreset: "tiny" }),
    /layout.marginPreset must be narrow, normal or wide/
  );
});

test("layout settings reject invalid numeric ranges and steps", () => {
  for (const value of [NaN, Infinity, 10.15, 10.1, 11.3]) {
    assert.throws(
      () => validateLayoutSettings({ fontSizePt: value }),
      /layout.fontSizePt must be between 10.2 and 11.2 in 0.1 steps/
    );
  }

  for (const value of [NaN, Infinity, 1.255, 1.24, 1.43]) {
    assert.throws(
      () => validateLayoutSettings({ lineHeight: value }),
      /layout.lineHeight must be between 1.25 and 1.42 in 0.01 steps/
    );
  }

  for (const value of [NaN, Infinity, 1.5, -1, 101]) {
    assert.throws(
      () => validateLayoutSettings({ spacingLevel: value }),
      /layout.spacingLevel must be an integer between 0 and 100/
    );
  }
});

test("spacing variables preserve tight compact normal and relaxed anchors", () => {
  assert.deepEqual(spacingVariables(0), {
    "--item-gap": "1px",
    "--section-gap": "4px",
    "--experience-gap": "3px",
    "--bullet-indent": "14px"
  });
  assert.deepEqual(spacingVariables(50), {
    "--item-gap": "2px",
    "--section-gap": "6px",
    "--experience-gap": "4px",
    "--bullet-indent": "15px"
  });
  assert.deepEqual(spacingVariables(67), {
    "--item-gap": "3px",
    "--section-gap": "8px",
    "--experience-gap": "5px",
    "--bullet-indent": "16px"
  });
  assert.deepEqual(spacingVariables(100), {
    "--item-gap": "4px",
    "--section-gap": "10px",
    "--experience-gap": "6px",
    "--bullet-indent": "17px"
  });
});

test("spacing variables interpolate every gap independently", () => {
  assert.deepEqual(spacingVariables(25), {
    "--item-gap": "1.5px",
    "--section-gap": "5px",
    "--experience-gap": "3.5px",
    "--bullet-indent": "14.5px"
  });
});

test("layout CSS variables include margins and proportional typography", () => {
  const vars = cssVariablesForLayout(DEFAULT_LAYOUT_SETTINGS);

  assert.equal(vars["--page-x"], "8mm");
  assert.equal(vars["--page-y"], "6mm");
  assert.equal(vars["--body-size"], "10.8pt");
  assert.equal(vars["--body-line-height"], "1.38");
  assert.equal(vars["--profile-size"], "12.3pt");
  assert.equal(vars["--section-title-size"], "14pt");
  assert.equal(vars["--skill-title-size"], "12.6pt");
  assert.equal(vars["--experience-title-size"], "13pt");
});

test("auto candidates follow compression phases and end at hard minima", () => {
  const candidates = buildLayoutCandidates({
    mode: "auto",
    fontSizePt: 11,
    lineHeight: 1.4,
    spacingLevel: 80,
    marginPreset: "wide"
  });

  assert.deepEqual(candidates[0].settings, {
    mode: "auto",
    fontSizePt: 11,
    lineHeight: 1.4,
    spacingLevel: 80,
    marginPreset: "wide"
  });
  assert.deepEqual(candidates.at(-1).settings, {
    mode: "auto",
    fontSizePt: 10.2,
    lineHeight: 1.25,
    spacingLevel: 0,
    marginPreset: "narrow"
  });

  const firstMarginChange = candidates.findIndex((entry) => entry.settings.marginPreset !== "wide");
  const firstLineHeightChange = candidates.findIndex((entry) => entry.settings.lineHeight !== 1.4);
  const firstFontChange = candidates.findIndex((entry) => entry.settings.fontSizePt !== 11);
  assert.ok(firstMarginChange > 0);
  assert.ok(firstLineHeightChange > firstMarginChange);
  assert.ok(firstFontChange > firstLineHeightChange);
  assert.ok(candidates.slice(0, firstMarginChange).every((entry) => entry.settings.spacingLevel >= 0));

  const signatures = candidates.map((entry) => JSON.stringify(entry.settings));
  assert.equal(new Set(signatures).size, signatures.length);
});

test("fixed mode returns exactly one public candidate", () => {
  const candidates = buildLayoutCandidates({
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(publicLayoutCandidate(candidates[0]), {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow",
    cssVariables: candidates[0].cssVariables
  });
});
