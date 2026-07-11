export const DEFAULT_LAYOUT_SETTINGS = Object.freeze({
  mode: "auto",
  fontSizePt: 10.8,
  lineHeight: 1.38,
  spacingLevel: 67,
  marginPreset: "normal"
});

export const LAYOUT_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_LAYOUT_SETTINGS));

const MODES = new Set(["auto", "fixed"]);
const MARGIN_PRESETS = new Set(["narrow", "normal", "wide"]);
const MARGINS = Object.freeze({
  narrow: Object.freeze({ x: 6, y: 4 }),
  normal: Object.freeze({ x: 8, y: 6 }),
  wide: Object.freeze({ x: 10, y: 8 })
});
const SPACING_ANCHORS = Object.freeze([
  Object.freeze({ level: 0, item: 1, section: 4, experience: 3, indent: 14 }),
  Object.freeze({ level: 50, item: 2, section: 6, experience: 4, indent: 15 }),
  Object.freeze({ level: 67, item: 3, section: 8, experience: 5, indent: 16 }),
  Object.freeze({ level: 100, item: 4, section: 10, experience: 6, indent: 17 })
]);
const TYPOGRAPHY_RATIOS = Object.freeze({
  "--profile-size": 12.3 / 10.8,
  "--section-title-size": 14 / 10.8,
  "--skill-title-size": 12.6 / 10.8,
  "--experience-title-size": 13 / 10.8
});

function formatNumber(value) {
  return String(Math.round(value * 100) / 100);
}

function validateSteppedNumber(value, field, min, max, scale, message) {
  if (!Number.isFinite(value)) {
    throw new Error(message);
  }
  const scaled = value * scale;
  if (!Number.isInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-8) {
    throw new Error(message);
  }
  if (value < min || value > max) {
    throw new Error(message);
  }
  return value;
}

export function validateLayoutSettings(settings = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("layout settings must be an object");
  }

  for (const key of Object.keys(settings)) {
    if (!LAYOUT_SETTING_KEYS.includes(key)) {
      throw new Error(`Unknown layout setting: ${key}`);
    }
  }

  const result = { ...settings };
  if ("mode" in result && !MODES.has(result.mode)) {
    throw new Error("layout.mode must be auto or fixed");
  }
  if ("fontSizePt" in result) {
    validateSteppedNumber(
      result.fontSizePt,
      "fontSizePt",
      10.2,
      11.2,
      10,
      "layout.fontSizePt must be between 10.2 and 11.2 in 0.1 steps"
    );
  }
  if ("lineHeight" in result) {
    validateSteppedNumber(
      result.lineHeight,
      "lineHeight",
      1.25,
      1.42,
      100,
      "layout.lineHeight must be between 1.25 and 1.42 in 0.01 steps"
    );
  }
  if ("spacingLevel" in result && (
    !Number.isFinite(result.spacingLevel)
    || !Number.isInteger(result.spacingLevel)
    || result.spacingLevel < 0
    || result.spacingLevel > 100
  )) {
    throw new Error("layout.spacingLevel must be an integer between 0 and 100");
  }
  if ("marginPreset" in result && !MARGIN_PRESETS.has(result.marginPreset)) {
    throw new Error("layout.marginPreset must be narrow, normal or wide");
  }
  return result;
}

export function resolveLayoutSettings(layout = {}) {
  return validateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, ...layout });
}

function interpolateAt(level, key) {
  const upperIndex = SPACING_ANCHORS.findIndex((anchor) => level <= anchor.level);
  if (upperIndex <= 0) {
    return SPACING_ANCHORS[0][key];
  }
  const lower = SPACING_ANCHORS[upperIndex - 1];
  const upper = SPACING_ANCHORS[upperIndex];
  const progress = (level - lower.level) / (upper.level - lower.level);
  return lower[key] + (upper[key] - lower[key]) * progress;
}

export function spacingVariables(level) {
  validateLayoutSettings({ spacingLevel: level });
  return {
    "--item-gap": `${formatNumber(interpolateAt(level, "item"))}px`,
    "--section-gap": `${formatNumber(interpolateAt(level, "section"))}px`,
    "--experience-gap": `${formatNumber(interpolateAt(level, "experience"))}px`,
    "--bullet-indent": `${formatNumber(interpolateAt(level, "indent"))}px`
  };
}

export function cssVariablesForLayout(layout = {}) {
  const settings = resolveLayoutSettings(layout);
  const margin = MARGINS[settings.marginPreset];
  const variables = {
    "--page-x": `${margin.x}mm`,
    "--page-y": `${margin.y}mm`,
    "--body-size": `${formatNumber(settings.fontSizePt)}pt`,
    "--body-line-height": formatNumber(settings.lineHeight),
    ...spacingVariables(settings.spacingLevel)
  };

  for (const [name, ratio] of Object.entries(TYPOGRAPHY_RATIOS)) {
    variables[name] = `${formatNumber(settings.fontSizePt * ratio)}pt`;
  }
  return variables;
}

function addCandidate(candidates, seen, settings) {
  const signature = JSON.stringify(settings);
  if (seen.has(signature)) {
    return;
  }
  seen.add(signature);
  candidates.push({ settings, cssVariables: cssVariablesForLayout(settings) });
}

function descendingSpacingLevels(start) {
  const values = new Set([start, 0]);
  for (const anchor of SPACING_ANCHORS) {
    if (anchor.level < start) {
      values.add(anchor.level);
    }
  }
  for (let value = Math.floor((start - 1) / 5) * 5; value >= 0; value -= 5) {
    values.add(value);
  }
  return [...values].filter((value) => value <= start).sort((left, right) => right - left);
}

export function buildLayoutCandidates(layout = {}) {
  const preferred = resolveLayoutSettings(layout);
  if (preferred.mode === "fixed") {
    return [{ settings: preferred, cssVariables: cssVariablesForLayout(preferred) }];
  }

  const candidates = [];
  const seen = new Set();
  let current = { ...preferred };
  for (const spacingLevel of descendingSpacingLevels(preferred.spacingLevel)) {
    current = { ...current, spacingLevel };
    addCandidate(candidates, seen, current);
  }

  const marginSequence = preferred.marginPreset === "wide"
    ? ["normal", "narrow"]
    : preferred.marginPreset === "normal"
      ? ["narrow"]
      : [];
  for (const marginPreset of marginSequence) {
    current = { ...current, marginPreset };
    addCandidate(candidates, seen, current);
  }

  for (let value = Math.round(preferred.lineHeight * 100) - 1; value >= 125; value -= 1) {
    current = { ...current, lineHeight: value / 100 };
    addCandidate(candidates, seen, current);
  }
  for (let value = Math.round(preferred.fontSizePt * 10) - 1; value >= 102; value -= 1) {
    current = { ...current, fontSizePt: value / 10 };
    addCandidate(candidates, seen, current);
  }
  return candidates;
}

export function publicLayoutCandidate(candidate) {
  return {
    ...candidate.settings,
    cssVariables: { ...candidate.cssVariables }
  };
}
