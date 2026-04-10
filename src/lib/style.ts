type StyleShape = Record<string, string | undefined>;
const PX_LENGTH_RE = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)px$/i;
const HEX_COLOR_RE = /^#([\da-f]{3,8})$/i;

type ParsedColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function formatPxValue(numeric: number): string {
  const rounded = Number(numeric.toFixed(2));
  return Number.isInteger(rounded) ? `${rounded}px` : `${rounded}px`;
}

export function normalizeLength(value: string | undefined): string {
  if (!value) {
    return "0";
  }

  const trimmed = normalizeWhitespace(value);
  if (trimmed === "0px" || trimmed === "0") {
    return "0";
  }

  const match = trimmed.match(PX_LENGTH_RE);
  if (!match) {
    return trimmed;
  }

  const numeric = Number.parseFloat(match[1]);
  return formatPxValue(numeric);
}

export function extractLengthPx(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = normalizeWhitespace(value).match(PX_LENGTH_RE);
  if (!match) {
    return null;
  }

  return Number.parseFloat(match[1]);
}

export function normalizeColor(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeWhitespace(value).replace(/,\s+/g, ",").toLowerCase();
  if (
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)" ||
    normalized === "rgba(255,255,255,0)"
  ) {
    return null;
  }

  const hexMatch = normalized.match(HEX_COLOR_RE);
  if (hexMatch) {
    const hex = hexMatch[1];
    const expanded =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : hex;

    if (expanded.length === 6) {
      const red = Number.parseInt(expanded.slice(0, 2), 16);
      const green = Number.parseInt(expanded.slice(2, 4), 16);
      const blue = Number.parseInt(expanded.slice(4, 6), 16);
      return `rgb(${red},${green},${blue})`;
    }

    if (expanded.length === 8) {
      const red = Number.parseInt(expanded.slice(0, 2), 16);
      const green = Number.parseInt(expanded.slice(2, 4), 16);
      const blue = Number.parseInt(expanded.slice(4, 6), 16);
      const alpha = Number.parseInt(expanded.slice(6, 8), 16) / 255;
      if (alpha <= 0) {
        return null;
      }

      const roundedAlpha = Number(alpha.toFixed(2));
      if (roundedAlpha >= 1) {
        return `rgb(${red},${green},${blue})`;
      }

      return `rgba(${red},${green},${blue},${roundedAlpha})`;
    }
  }

  const rgbFunctionMatch = normalized.match(/^rgba?\((.+)\)$/);
  if (rgbFunctionMatch) {
    const segments = rgbFunctionMatch[1]
      .replace(/\//g, ",")
      .split(/[,\s]+/)
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length >= 3) {
      const [rawRed, rawGreen, rawBlue, rawAlpha] = segments;
      const red = Number.parseFloat(rawRed);
      const green = Number.parseFloat(rawGreen);
      const blue = Number.parseFloat(rawBlue);
      const alpha = rawAlpha === undefined ? 1 : Number.parseFloat(rawAlpha);

      if ([red, green, blue, alpha].some((entry) => Number.isNaN(entry))) {
        return normalized;
      }

      if (alpha <= 0) {
        return null;
      }

      if (alpha >= 1) {
        return `rgb(${Math.round(red)},${Math.round(green)},${Math.round(blue)})`;
      }

      return `rgba(${Math.round(red)},${Math.round(green)},${Math.round(blue)},${Number(alpha.toFixed(2))})`;
    }
  }

  return normalized;
}

export function parseColor(value: string | undefined): ParsedColor | null {
  const normalized = normalizeColor(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^rgba?\((.+)\)$/);
  if (!match) {
    return null;
  }

  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return null;
  }

  const red = Number.parseFloat(parts[0]);
  const green = Number.parseFloat(parts[1]);
  const blue = Number.parseFloat(parts[2]);
  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);

  if ([red, green, blue, alpha].some((entry) => Number.isNaN(entry))) {
    return null;
  }

  return { red, green, blue, alpha };
}

export function getColorBrightness(value: string | undefined): number | null {
  const color = parseColor(value);
  if (!color) {
    return null;
  }

  return color.red * 0.299 + color.green * 0.587 + color.blue * 0.114;
}

export function isDarkColor(value: string | undefined): boolean {
  const brightness = getColorBrightness(value);
  return brightness !== null && brightness < 90;
}

export function isLightColor(value: string | undefined): boolean {
  const brightness = getColorBrightness(value);
  return brightness !== null && brightness >= 200;
}

export function hasTransparency(value: string | undefined): boolean {
  const color = parseColor(value);
  return Boolean(color && color.alpha < 1);
}

export function isNeutralColor(value: string | undefined): boolean {
  const color = parseColor(value);
  if (!color) {
    return false;
  }

  const max = Math.max(color.red, color.green, color.blue);
  const min = Math.min(color.red, color.green, color.blue);
  return max - min <= 18;
}

export function isAccentColor(value: string | undefined): boolean {
  const color = parseColor(value);
  if (!color) {
    return false;
  }

  const max = Math.max(color.red, color.green, color.blue);
  const min = Math.min(color.red, color.green, color.blue);
  const brightness = getColorBrightness(value);

  return max - min >= 36 && brightness !== null && brightness > 35 && brightness < 235;
}

export function normalizeFontFamily(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  return value
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
}

export function normalizeShadow(value: string | undefined): string {
  if (!value) {
    return "none";
  }

  return normalizeWhitespace(value.replace(/,\s+/g, ","));
}

export function normalizeSpacingToken(value: string | undefined): string | null {
  const px = extractLengthPx(value);
  if (px === null || px <= 0 || px > 240) {
    return null;
  }

  return formatPxValue(px);
}

export function normalizeRadiusToken(value: string | undefined): string | null {
  const px = extractLengthPx(value);
  if (px === null || px <= 0) {
    return null;
  }

  if (px >= 999) {
    return "pill";
  }

  if (px > 160) {
    return null;
  }

  return formatPxValue(px);
}

export function normalizeContainerWidthToken(value: string | undefined): string | null {
  const px = extractLengthPx(value);
  if (px === null || px < 240 || px > 2000) {
    return null;
  }

  return formatPxValue(px);
}

export function incrementCount(map: Map<string, number>, key: string | null | undefined, amount = 1): void {
  if (!key) {
    return;
  }

  map.set(key, (map.get(key) ?? 0) + amount);
}

export function mapToSortedCountedValues(
  map: Map<string, number>,
  limit = 8,
  usage?: (value: string) => string[]
): Array<{ value: string; count: number; usage: string[] }> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({
      value,
      count,
      usage: usage ? usage(value) : []
    }));
}

export function buildStyleSignature(style: StyleShape): string {
  const fields = [
    ["font", normalizeFontFamily(style.fontFamily)],
    ["size", normalizeLength(style.fontSize)],
    ["weight", normalizeWhitespace(style.fontWeight ?? "400")],
    ["line", normalizeLength(style.lineHeight)],
    ["color", normalizeColor(style.color) ?? "none"],
    ["bg", normalizeColor(style.backgroundColor) ?? "none"],
    ["radius", normalizeRadiusToken(style.borderRadius) ?? normalizeLength(style.borderRadius)],
    ["shadow", normalizeShadow(style.boxShadow)],
    ["padY", normalizeSpacingToken(style.paddingTop) ?? normalizeLength(style.paddingTop)],
    ["padX", normalizeSpacingToken(style.paddingLeft) ?? normalizeLength(style.paddingLeft)],
    ["display", normalizeWhitespace(style.display ?? "block")]
  ];

  return fields.map(([key, value]) => `${key}:${value}`).join(" | ");
}

export function colorNarrativePriority(usage: string[]): number {
  if (usage.includes("background") && usage.includes("text")) {
    return 4;
  }
  if (usage.includes("text")) {
    return 3;
  }
  if (usage.includes("background")) {
    return 2;
  }
  if (usage.includes("border")) {
    return 1;
  }
  return 0;
}

export function sortColorsForNarrative<T extends { value: string; count: number; usage: string[] }>(colors: T[]): T[] {
  return [...colors].sort((left, right) => {
    const priority = colorNarrativePriority(right.usage) - colorNarrativePriority(left.usage);
    if (priority !== 0) {
      return priority;
    }

    return right.count - left.count || left.value.localeCompare(right.value);
  });
}

export function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}
