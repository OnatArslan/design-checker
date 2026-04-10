import type { Page } from "playwright";

import type { ComponentExample, CountedValue, PageLayout, PageTokens, TypographyToken } from "../schema.js";
import {
  buildStyleSignature,
  extractLengthPx,
  incrementCount,
  mapToSortedCountedValues,
  normalizeColor,
  normalizeContainerWidthToken,
  normalizeFontFamily,
  normalizeLength,
  normalizeRadiusToken,
  normalizeShadow,
  normalizeSpacingToken,
  sortColorsForNarrative,
  uniqueBy
} from "./style.js";
import type { LinkCandidate } from "./links.js";

type RawBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RawElementSnapshot = {
  tagName: string;
  type: string;
  role: string;
  id: string;
  classList: string[];
  selectorHint: string;
  textSnippet: string;
  htmlSnippet: string;
  boundingBox: RawBoundingBox;
  inHeader: boolean;
  inNav: boolean;
  inMain: boolean;
  inFooter: boolean;
  styles: Record<string, string>;
};

export type RawPageDomData = {
  title: string;
  elements: RawElementSnapshot[];
  linkCandidates: LinkCandidate[];
  pageBaseStyles: Record<string, string>;
};

const STYLE_PROPERTIES = [
  "display",
  "position",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "textTransform",
  "letterSpacing",
  "color",
  "backgroundColor",
  "borderColor",
  "borderRadius",
  "borderWidth",
  "boxShadow",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginBottom",
  "gap",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gridTemplateColumns",
  "maxWidth",
  "width",
  "minHeight"
] as const;

type PageProcessResult = {
  pageSummary: string;
  components: ComponentExample[];
  layout: PageLayout;
  tokens: PageTokens;
};

export async function preparePage(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page
    .waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5_000) })
    .catch(() => undefined);
  await page
    .addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          scroll-behavior: auto !important;
          caret-color: auto !important;
        }
      `
    })
    .catch(() => undefined);
  await page.evaluate(async () => {
    if ("fonts" in document) {
      await (document as Document & { fonts: FontFaceSet }).fonts.ready;
    }
  });
}

export async function collectRawPageDomData(page: Page): Promise<RawPageDomData> {
  return page.evaluate((styleProperties) => {
    const whitelist = new Set([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "nav",
      "header",
      "footer",
      "section",
      "article",
      "main",
      "form",
      "label",
      "div",
      "li",
      "ul",
      "ol",
      "h1",
      "h2",
      "h3",
      "h4",
      "p"
    ]);

    const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
    const colorProperties = new Set(["color", "backgroundColor", "borderColor"]);
    const colorCache = new Map<string, string>();
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext("2d");

    const canonicalizeColor = (value: string) => {
      const normalized = value.replace(/\s+/g, " ").trim();
      if (!normalized) {
        return normalized;
      }

      const cached = colorCache.get(normalized);
      if (cached) {
        return cached;
      }

      let resolved = normalized;
      if (colorContext) {
        try {
          colorContext.clearRect(0, 0, 1, 1);
          colorContext.fillStyle = normalized;
          colorContext.fillRect(0, 0, 1, 1);
          const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
          if (alpha === 255) {
            resolved = `rgb(${red},${green},${blue})`;
          } else {
            resolved = `rgba(${red},${green},${blue},${Number((alpha / 255).toFixed(2))})`;
          }
        } catch {
          resolved = normalized;
        }
      }
      colorCache.set(normalized, resolved);
      return resolved;
    };

    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element as HTMLElement);
      const rect = (element as HTMLElement).getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 4 &&
        rect.height > 4
      );
    };

    const selectorHint = (element: Element) => {
      const parts: string[] = [];
      let current: Element | null = element;

      while (current && parts.length < 4) {
        const tagName = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`#${current.id}`);
          break;
        }

        const className = Array.from(current.classList)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("");
        parts.unshift(`${tagName}${className}`);
        current = current.parentElement;
      }

      return parts.join(" > ");
    };

    const getZone = (element: Element): LinkCandidate["zone"] => {
      if (element.closest("header")) {
        return "header";
      }
      if (element.closest("nav")) {
        return "nav";
      }
      if (element.closest("main")) {
        return "main";
      }
      if (element.closest("footer")) {
        return "footer";
      }
      return "other";
    };

    const elements = Array.from(document.querySelectorAll("body *"))
      .filter((element) => whitelist.has(element.tagName.toLowerCase()))
      .filter((element) => isVisible(element))
      .slice(0, 700)
      .map((element) => {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const computed = window.getComputedStyle(htmlElement);
        const styleEntries = Object.fromEntries(
          styleProperties.map((property) => {
            const rawValue = String(computed[property as keyof CSSStyleDeclaration] ?? "");
            const value = colorProperties.has(property) ? canonicalizeColor(rawValue) : rawValue;
            return [property, value];
          })
        ) as Record<string, string>;
        return {
          tagName: element.tagName.toLowerCase(),
          type: htmlElement.getAttribute("type") ?? "",
          role: htmlElement.getAttribute("role") ?? "",
          id: htmlElement.id ?? "",
          classList: Array.from(htmlElement.classList).slice(0, 8),
          selectorHint: selectorHint(element),
          textSnippet: normalizeText(htmlElement.innerText || htmlElement.textContent || "").slice(0, 140),
          htmlSnippet: htmlElement.outerHTML.replace(/\s+/g, " ").slice(0, 240),
          boundingBox: {
            x: Number(rect.x.toFixed(1)),
            y: Number(rect.y.toFixed(1)),
            width: Number(rect.width.toFixed(1)),
            height: Number(rect.height.toFixed(1))
          },
          inHeader: Boolean(element.closest("header")),
          inNav: Boolean(element.closest("nav")),
          inMain: Boolean(element.closest("main")),
          inFooter: Boolean(element.closest("footer")),
          styles: styleEntries
        };
      });

    const linkCandidates = Array.from(document.querySelectorAll("a[href]"))
      .filter((element) => isVisible(element))
      .map((element) => {
        const htmlElement = element as HTMLAnchorElement;
        const rect = htmlElement.getBoundingClientRect();
        return {
          url: htmlElement.href,
          text: normalizeText(htmlElement.innerText || htmlElement.textContent || "").slice(0, 80),
          zone: getZone(element),
          area: Number((rect.width * rect.height).toFixed(1))
        };
      });

    const styleCandidates = [
      document.body,
      document.querySelector("main"),
      document.documentElement
    ].filter(Boolean) as HTMLElement[];

    const pickFirstOpaqueBackground = () => {
      for (const node of styleCandidates) {
        const backgroundColor = canonicalizeColor(window.getComputedStyle(node).backgroundColor);
        if (backgroundColor && backgroundColor !== "rgba(0,0,0,0)") {
          return backgroundColor;
        }
      }

      return "rgba(0,0,0,0)";
    };

    const bodyStyle = window.getComputedStyle(document.body);
    const htmlStyle = window.getComputedStyle(document.documentElement);
    const pageBaseStyles = {
      backgroundColor: pickFirstOpaqueBackground(),
      color: canonicalizeColor(bodyStyle.color || htmlStyle.color || ""),
      fontFamily: bodyStyle.fontFamily || htmlStyle.fontFamily || "",
      lineHeight: bodyStyle.lineHeight || htmlStyle.lineHeight || "",
      fontSize: bodyStyle.fontSize || htmlStyle.fontSize || ""
    };

    return {
      title: document.title || "",
      elements,
      linkCandidates,
      pageBaseStyles
    };
  }, STYLE_PROPERTIES);
}

function matchesSemanticToken(value: string, pattern: RegExp): boolean {
  const normalized = value.toLowerCase();
  return pattern.test(normalized);
}

function hasSemanticClass(element: RawElementSnapshot, pattern: RegExp): boolean {
  return element.classList.some((className) => matchesSemanticToken(className, pattern));
}

function hasSemanticId(element: RawElementSnapshot, pattern: RegExp): boolean {
  return Boolean(element.id) && matchesSemanticToken(element.id, pattern);
}

function containsHeadingMarkup(element: RawElementSnapshot, level: "h1" | "h2" | "h3"): boolean {
  return new RegExp(`<${level}[\\s>]`, "i").test(element.htmlSnippet);
}

function classifyComponent(element: RawElementSnapshot): string | null {
  const tag = element.tagName;
  const hasNavbarSemantics =
    hasSemanticClass(element, /(?:^|[_-])(navbar|navigation|topbar|topnav|menu)(?:[_-]|$)/) ||
    hasSemanticId(element, /(?:^|[_-])(navbar|navigation|topnav)(?:[_-]|$)/);
  const hasFooterSemantics =
    hasSemanticClass(element, /(?:^|[_-])(footer)(?:[_-]|$)/) ||
    hasSemanticId(element, /(?:^|[_-])(footer)(?:[_-]|$)/);
  const hasHeroSemantics =
    hasSemanticClass(element, /(?:^|[_-])(hero|masthead|banner|headline)(?:[_-]|$)/) ||
    hasSemanticId(element, /(?:^|[_-])(hero|product|overview)(?:[_-]|$)/);
  const hasSectionSemantics =
    hasSemanticClass(element, /(?:^|[_-])(section|content|feature|highlight)(?:[_-]|$)/) ||
    hasSemanticId(element, /(?:^|[_-])(section|features|how-it-works|open-source|faqs?)(?:[_-]|$)/);
  const hasCardSemantics = hasSemanticClass(
    element,
    /(?:^|[_-])(card|tile|window|panel|frame|popover|modal|dialog)(?:[_-]|$)/
  );
  const hasH1 = containsHeadingMarkup(element, "h1");
  const hasHeading = hasH1 || containsHeadingMarkup(element, "h2");
  const backgroundColor = normalizeColor(element.styles.backgroundColor);
  const paddingY = extractLengthPx(element.styles.paddingTop) ?? 0;
  const radius = extractLengthPx(element.styles.borderRadius) ?? 0;
  const shadow = normalizeShadow(element.styles.boxShadow);
  const width = element.boundingBox.width;
  const height = element.boundingBox.height;
  const borderWidth = extractLengthPx(element.styles.borderWidth) ?? 0;
  const isFullBleedShell =
    element.boundingBox.x <= 1 &&
    element.boundingBox.y <= 1 &&
    width >= 1400 &&
    height >= 800 &&
    !element.id &&
    !hasHeroSemantics;

  if (isFullBleedShell && tag === "div") {
    return null;
  }

  if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(element.type))) {
    return "button";
  }

  if (
    tag === "a" &&
    (element.role === "button" ||
      hasSemanticClass(element, /(?:^|[_-])(button|btn|cta)(?:[_-]|$)/) ||
      (!!backgroundColor && backgroundColor !== "rgba(0,0,0,0)" && paddingY >= 8))
  ) {
    return "link-button";
  }

  if (["input", "select", "textarea"].includes(tag)) {
    return "input";
  }

  if (
    tag === "header" ||
    tag === "nav" ||
    ((tag === "div" || tag === "section") && hasNavbarSemantics && width >= 320 && height >= 40)
  ) {
    return "navbar";
  }

  if (
    tag === "footer" ||
    ((tag === "div" || tag === "section") && (hasFooterSemantics || element.inFooter) && width >= 320 && height >= 80)
  ) {
    return "footer";
  }

  if (
    ["div", "section", "article", "main"].includes(tag) &&
    !element.inFooter &&
    !element.inHeader &&
    height >= 140 &&
    height <= 1800 &&
    width >= 560 &&
    (hasHeroSemantics ||
      hasH1 ||
      (hasHeading && element.boundingBox.y < 900 && element.textSnippet.length > 40 && width < 1400))
  ) {
    return "hero";
  }

  if (
    ["article", "section", "div", "li"].includes(tag) &&
    width >= 180 &&
    width <= 760 &&
    height >= 120 &&
    height <= 640 &&
    (hasCardSemantics ||
      tag === "article" ||
      tag === "li" ||
      ((radius >= 8 || shadow !== "none" || borderWidth === 1) && element.textSnippet.length > 12))
  ) {
    return "card";
  }

  if (
    (tag === "section" || tag === "article" || hasSectionSemantics || Boolean(element.id)) &&
    !element.inHeader &&
    !element.inFooter &&
    width >= 400 &&
    height >= 120 &&
    height <= 2200
  ) {
    return "section";
  }

  if (
    ["div", "section", "article", "main"].includes(tag) &&
    (extractLengthPx(element.styles.maxWidth) ?? 0) >= 720 &&
    width >= 480 &&
    height >= 60 &&
    height <= 1800 &&
    !element.inHeader &&
    !element.inFooter
  ) {
    return "container";
  }

  return null;
}

function scoreComponentCandidate(element: RawElementSnapshot, kind: string): number {
  let score = 0;
  const area = element.boundingBox.width * element.boundingBox.height;
  const tag = element.tagName;
  const hasH1 = containsHeadingMarkup(element, "h1");
  const hasHeading = hasH1 || containsHeadingMarkup(element, "h2");

  if (["header", "nav", "footer", "section", "article", "button", "a"].includes(tag)) {
    score += 10;
  }
  if (tag === "div") {
    score -= 4;
  }
  if (kind === "hero" && tag === "section") {
    score += 12;
  }
  if (kind === "hero" && hasH1) {
    score += 18;
  }
  if (kind === "hero" && hasHeading) {
    score += 8;
  }
  if (kind === "navbar" && (tag === "header" || tag === "nav")) {
    score += 12;
  }
  if (kind === "footer" && tag === "footer") {
    score += 14;
  }
  if (kind === "navbar" && element.inHeader) {
    score += 6;
  }
  if (kind === "footer" && element.inFooter) {
    score += 6;
  }
  if (kind === "card" && tag === "article") {
    score += 8;
  }
  if (kind === "link-button" && tag === "a") {
    score += 10;
  }
  if (kind === "button" && tag === "button") {
    score += 10;
  }
  if (element.id) {
    score += 5;
  }
  if (element.textSnippet.length > 0 && element.textSnippet.length < 180) {
    score += 4;
  }
  if (area > 1_600_000) {
    score -= 20;
  }
  if (element.boundingBox.height > 2400) {
    score -= 24;
  }
  if (element.boundingBox.height > 6_000) {
    score -= 40;
  }
  if (element.boundingBox.width >= 1400 && tag === "div") {
    score -= 8;
  }

  return score;
}

function buildComponentExamples(elements: RawElementSnapshot[]): ComponentExample[] {
  const perKindLimit: Record<string, number> = {
    hero: 2,
    navbar: 1,
    footer: 1,
    container: 2,
    "link-button": 3,
    button: 2,
    card: 2,
    section: 2,
    input: 2
  };

  const ranked = elements
    .map((element) => {
      const kind = classifyComponent(element);
      return { element, kind, score: kind ? scoreComponentCandidate(element, kind) : Number.NEGATIVE_INFINITY };
    })
    .filter((entry): entry is { element: RawElementSnapshot; kind: string; score: number } => Boolean(entry.kind))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.element.boundingBox.y - right.element.boundingBox.y ||
        left.element.boundingBox.width * left.element.boundingBox.height -
          right.element.boundingBox.width * right.element.boundingBox.height
    );

  const perKind = new Map<string, number>();
  const examples = ranked
    .map(({ element, kind }) => ({
      kind,
      tagName: element.tagName,
      selectorHint: element.selectorHint,
      classList: element.classList,
      textSnippet: element.textSnippet,
      htmlSnippet: element.htmlSnippet,
      boundingBox: element.boundingBox,
      styleSignature: buildStyleSignature(element.styles),
      cssRules: []
    }))
    .filter((component) => {
      const current = perKind.get(component.kind) ?? 0;
      const limit = perKindLimit[component.kind] ?? 2;
      if (current >= limit) {
        return false;
      }

      perKind.set(component.kind, current + 1);
      return true;
    });

  return uniqueBy(examples, (component) => `${component.kind}:${component.styleSignature}`)
    .sort((left, right) => left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x)
    .slice(0, 16);
}

function buildTypography(elements: RawElementSnapshot[]): TypographyToken[] {
  const counts = new Map<string, number>();

  for (const element of elements) {
    const family = normalizeFontFamily(element.styles.fontFamily);
    const size = normalizeLength(element.styles.fontSize);
    const weight = element.styles.fontWeight || "400";
    const lineHeight = normalizeLength(element.styles.lineHeight);
    const key = `${family}|${size}|${weight}|${lineHeight}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([key, count]) => {
      const [family, size, weight, lineHeight] = key.split("|");
      return { family, size, weight, lineHeight, count };
    });
}

function buildTokens(rawPage: RawPageDomData): PageTokens {
  const colorUsage = new Map<string, Set<string>>();
  const colorCounts = new Map<string, number>();
  const backgroundCounts = new Map<string, number>();
  const spacingCounts = new Map<string, number>();
  const radiusCounts = new Map<string, number>();
  const shadowCounts = new Map<string, number>();

  for (const element of rawPage.elements) {
    const color = normalizeColor(element.styles.color);
    const background = normalizeColor(element.styles.backgroundColor);
    const border = normalizeColor(element.styles.borderColor);
    const paddingTop = normalizeSpacingToken(element.styles.paddingTop);
    const gap = normalizeSpacingToken(element.styles.gap);
    const radius = normalizeRadiusToken(element.styles.borderRadius);
    const shadow = normalizeShadow(element.styles.boxShadow);

    if (color) {
      incrementCount(colorCounts, color);
      const usages = colorUsage.get(color) ?? new Set<string>();
      usages.add("text");
      colorUsage.set(color, usages);
    }

    if (background) {
      incrementCount(colorCounts, background);
      incrementCount(backgroundCounts, background);
      const usages = colorUsage.get(background) ?? new Set<string>();
      usages.add("background");
      colorUsage.set(background, usages);
    }

    if (border) {
      incrementCount(colorCounts, border);
      const usages = colorUsage.get(border) ?? new Set<string>();
      usages.add("border");
      colorUsage.set(border, usages);
    }

    if (paddingTop) {
      incrementCount(spacingCounts, paddingTop);
    }

    if (gap) {
      incrementCount(spacingCounts, gap);
    }

    if (radius) {
      incrementCount(radiusCounts, radius);
    }

    if (shadow !== "none") {
      incrementCount(shadowCounts, shadow);
    }
  }

  const pageBackground = normalizeColor(rawPage.pageBaseStyles.backgroundColor);
  const pageColor = normalizeColor(rawPage.pageBaseStyles.color);

  if (pageBackground) {
    incrementCount(colorCounts, pageBackground, 6);
    incrementCount(backgroundCounts, pageBackground, 6);
    const usages = colorUsage.get(pageBackground) ?? new Set<string>();
    usages.add("background");
    colorUsage.set(pageBackground, usages);
  }

  if (pageColor) {
    incrementCount(colorCounts, pageColor, 4);
    const usages = colorUsage.get(pageColor) ?? new Set<string>();
    usages.add("text");
    colorUsage.set(pageColor, usages);
  }

  const colors = sortColorsForNarrative(
    [...colorCounts.entries()].map(([value, count]) => ({
      value,
      count,
      usage: [...(colorUsage.get(value) ?? new Set<string>())].sort()
    }))
  ).slice(0, 10);

  return {
    colors,
    typography: buildTypography(rawPage.elements),
    spacingScale: mapToSortedCountedValues(spacingCounts, 8),
    radii: mapToSortedCountedValues(radiusCounts, 6),
    shadows: mapToSortedCountedValues(shadowCounts, 6),
    backgrounds: mapToSortedCountedValues(backgroundCounts, 8, () => ["background"])
  };
}

function buildLayout(elements: RawElementSnapshot[]): PageLayout {
  const displayCounts = new Map<string, number>();
  const containerWidths = new Map<string, number>();
  const sectionSpacing = new Map<string, number>();
  const gapValues = new Map<string, number>();
  let gridCount = 0;
  let flexCount = 0;

  for (const element of elements) {
    const display = element.styles.display || "block";
    incrementCount(displayCounts, display);

    if (display === "grid") {
      gridCount += 1;
    }
    if (display === "flex") {
      flexCount += 1;
    }

    const maxWidth = normalizeContainerWidthToken(element.styles.maxWidth);
    if (maxWidth) {
      incrementCount(containerWidths, maxWidth);
    }

    const sectionGap = normalizeSpacingToken(element.styles.marginTop);
    if ((element.tagName === "section" || element.boundingBox.width > 500) && sectionGap) {
      incrementCount(sectionSpacing, sectionGap);
    }

    const gap = normalizeSpacingToken(element.styles.gap);
    if (gap) {
      incrementCount(gapValues, gap);
    }
  }

  return {
    displayModes: mapToSortedCountedValues(displayCounts, 6),
    containerWidths: mapToSortedCountedValues(containerWidths, 6),
    sectionSpacing: mapToSortedCountedValues(sectionSpacing, 6),
    dominantGapValues: mapToSortedCountedValues(gapValues, 6),
    notes: [
      flexCount > 0 ? `Flex layouts appear ${flexCount} times.` : "",
      gridCount > 0 ? `Grid layouts appear ${gridCount} times.` : ""
    ].filter(Boolean)
  };
}

function buildPageSummary(
  title: string,
  tokens: PageTokens,
  layout: PageLayout,
  components: ComponentExample[]
): string {
  const narrativeColors = uniqueBy(
    [
      ...tokens.backgrounds.slice(0, 2),
      ...sortColorsForNarrative(tokens.colors).slice(0, 4)
    ],
    (token) => token.value
  );
  const primaryColors = narrativeColors.slice(0, 3).map((token) => token.value).join(", ") || "muted neutrals";
  const typeLead = tokens.typography[0]
    ? `${tokens.typography[0].family} at ${tokens.typography[0].size}`
    : "default sans typography";
  const componentLead = uniqueBy(components, (component) => component.kind)
    .slice(0, 4)
    .map((component) => component.kind)
    .join(", ");
  const layoutLead =
    layout.displayModes[0]?.value === "flex"
      ? "flex-led layout rhythm"
      : layout.displayModes[0]?.value === "grid"
        ? "grid-led layout rhythm"
        : "block-first layout rhythm";

  return `${title || "Untitled page"} uses ${primaryColors} with ${typeLead}, ${layoutLead}, and recurring ${componentLead || "content"} patterns.`;
}

export function processRawPageData(rawPage: RawPageDomData): PageProcessResult {
  const tokens = buildTokens(rawPage);
  const components = buildComponentExamples(rawPage.elements);
  const layout = buildLayout(rawPage.elements);
  const pageSummary = buildPageSummary(rawPage.title, tokens, layout, components);

  return {
    pageSummary,
    components,
    layout,
    tokens
  };
}
