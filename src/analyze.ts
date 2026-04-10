import { writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext } from "playwright";

import {
  analyzeOptionsSchema,
  designAnalysisBundleSchema,
  type AnalysisError,
  type AnalyzeOptions,
  type DesignAnalysisBundle,
  type DesignIntent,
  type DesignSystem,
  type PageDesignSnapshot,
  type TypographyToken
} from "./schema.js";
import { attachCssRulesToComponents, summarizeCssSource, type CapturedCssSource } from "./lib/css.js";
import { collectRawPageDomData, preparePage, processRawPageData } from "./lib/extract.js";
import { createArtifactDir, ensureDir, slugifyUrl } from "./lib/fs.js";
import { selectRepresentativeLinks, type LinkCandidate } from "./lib/links.js";
import {
  hasTransparency,
  isAccentColor,
  isDarkColor,
  isLightColor,
  isNeutralColor,
  sortColorsForNarrative
} from "./lib/style.js";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export class AnalyzeSiteError extends Error {
  readonly bundle: DesignAnalysisBundle;
  readonly outputDir: string;
  readonly analysisPath: string;

  constructor(message: string, bundle: DesignAnalysisBundle, outputDir: string) {
    super(message);
    this.name = "AnalyzeSiteError";
    this.bundle = bundle;
    this.outputDir = outputDir;
    this.analysisPath = path.join(outputDir, "analysis.json");
  }
}

type CollectedPageArtifacts = {
  snapshot: PageDesignSnapshot;
  linkCandidates: LinkCandidate[];
  resolvedUrl: string;
};

function mergeCountedValues(
  groups: Array<Array<{ value: string; count: number; usage?: string[] }>>,
  limit: number
): Array<{ value: string; count: number; usage: string[] }> {
  const map = new Map<string, { count: number; usage: Set<string> }>();

  for (const group of groups) {
    for (const entry of group) {
      const current = map.get(entry.value) ?? { count: 0, usage: new Set<string>() };
      current.count += entry.count;
      for (const usage of entry.usage ?? []) {
        current.usage.add(usage);
      }
      map.set(entry.value, current);
    }
  }

  return [...map.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, data]) => ({
      value,
      count: data.count,
      usage: [...data.usage].sort()
    }));
}

function mergeTypography(groups: TypographyToken[][]): TypographyToken[] {
  const map = new Map<string, number>();

  for (const group of groups) {
    for (const token of group) {
      const key = `${token.family}|${token.size}|${token.weight}|${token.lineHeight}`;
      map.set(key, (map.get(key) ?? 0) + token.count);
    }
  }

  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([key, count]) => {
      const [family, size, weight, lineHeight] = key.split("|");
      return { family, size, weight, lineHeight, count };
    });
}

const PX_VALUE_RE = /^(-?\d+(?:\.\d+)?)px$/i;
const CANONICAL_SPACING_SCALE = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96];

function parsePxValue(value: string): number | null {
  const match = value.trim().match(PX_VALUE_RE);
  return match ? Number.parseFloat(match[1]) : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildSpacingNarrative(values: string[]): string[] {
  const normalized = uniqueStrings(
    values
      .map(parsePxValue)
      .filter((value): value is number => value !== null)
      .map((value) => {
        const nearest = CANONICAL_SPACING_SCALE.reduce((best, current) =>
          Math.abs(current - value) < Math.abs(best - value) ? current : best
        );
        return `${nearest}px`;
      })
  ).slice(0, 6);

  if (normalized.length === 0) {
    return ["Spacing should feel compact and product-like, anchored on an 8px rhythm."];
  }

  const lead = normalized.slice(0, 5).join(", ");
  return [
    `Use a compact spacing ladder that repeatedly falls on ${lead}.`,
    "Favor tighter control spacing over oversized marketing whitespace."
  ];
}

function buildShapeNarrative(designSystem: DesignSystem): string[] {
  const radii = designSystem.radii
    .map((item) => item.value)
    .filter((value) => value !== "pill")
    .slice(0, 4);
  const hasInsetShadows = designSystem.shadows.some((item) => item.value.includes("inset"));
  const narrative = [];

  if (radii.length > 0) {
    narrative.push(`Corners cluster around ${radii.join(", ")}, keeping controls tight rather than bubbly.`);
  }
  if (hasInsetShadows) {
    narrative.push("Buttons and cards use inset highlights and layered shadows to feel glossy and tactile.");
  }

  return narrative;
}

function buildTypographyNarrative(designSystem: DesignSystem): string[] {
  const families = designSystem.fontAssets.map((item) => item.family);
  const uiFamily = families[0];
  const hasNativeUiAccent = families.some((family) => family.includes("sf pro"));
  const dominantSizes = uniqueStrings(designSystem.typography.map((item) => item.size)).slice(0, 4);
  const narrative = [];

  if (uiFamily) {
    narrative.push(`Primary UI typography uses ${uiFamily}.`);
  }
  if (dominantSizes.length > 0) {
    narrative.push(`Body and control sizes concentrate around ${dominantSizes.join(", ")}.`);
  }
  if (hasNativeUiAccent) {
    narrative.push("Product previews borrow native desktop typography to reinforce a macOS utility feel.");
  }

  return narrative;
}

function buildLayoutNarrative(designSystem: DesignSystem, pages: PageDesignSnapshot[]): string[] {
  const layoutModes = designSystem.layoutPatterns.map((item) => item.name);
  const containerWidths = mergeCountedValues(pages.map((page) => page.layout.containerWidths), 8)
    .map((item) => item.value)
    .map(parsePxValue)
    .filter((value): value is number => value !== null);
  const hasWideContent = containerWidths.some((value) => value >= 1100);
  const hasNarrowReadingWidth = containerWidths.some((value) => value <= 760);
  const narrative = [];

  if (layoutModes.includes("flex") && layoutModes.includes("grid")) {
    narrative.push("Use flex for primary composition, with grid reserved for dense product showcases and feature matrices.");
  } else if (layoutModes.length > 0) {
    narrative.push(`The layout language is led by ${layoutModes.slice(0, 2).join(" and ")} patterns.`);
  }

  if (hasWideContent && hasNarrowReadingWidth) {
    narrative.push("Alternate between wide product sections and narrower editorial reading widths.");
  } else if (hasWideContent) {
    narrative.push("Keep major sections inside generous desktop-width containers rather than full-bleed content blocks.");
  }

  return narrative;
}

function buildColorRoles(designSystem: DesignSystem): DesignIntent["colorRoles"] {
  const backgrounds = designSystem.backgrounds;
  const allColors = uniqueStrings([
    ...backgrounds.map((item) => item.value),
    ...sortColorsForNarrative(designSystem.colors).map((item) => item.value)
  ]);
  const pageBackgroundValue =
    backgrounds.find((item) => isDarkColor(item.value) || isLightColor(item.value))?.value ??
    allColors.find((value) => isDarkColor(value) || isLightColor(value)) ??
    allColors[0] ??
    "rgb(255,255,255)";
  const darkFirst = isDarkColor(pageBackgroundValue);
  const primaryTextValue =
    sortColorsForNarrative(designSystem.colors)
      .filter((item) => item.usage.includes("text"))
      .map((item) => item.value)
      .find((value) => (darkFirst ? isLightColor(value) || !isDarkColor(value) : isDarkColor(value))) ??
    sortColorsForNarrative(designSystem.colors).find((item) => item.usage.includes("text"))?.value ??
    "rgb(255,255,255)";
  const mutedTextValue =
    sortColorsForNarrative(designSystem.colors)
      .filter((item) => item.usage.includes("text"))
      .map((item) => item.value)
      .find((value) => value !== primaryTextValue && (hasTransparency(value) || isNeutralColor(value))) ??
    sortColorsForNarrative(designSystem.colors)
      .filter((item) => item.usage.includes("text"))
      .map((item) => item.value)
      .find((value) => value !== primaryTextValue) ??
    primaryTextValue;
  const surfaceValue =
    backgrounds.find((item) => item.value !== pageBackgroundValue && hasTransparency(item.value))?.value ??
    backgrounds.find((item) => item.value !== pageBackgroundValue)?.value ??
    pageBackgroundValue;
  const accentValue =
    allColors.find(
      (value) =>
        value !== pageBackgroundValue && value !== primaryTextValue && value !== mutedTextValue && isAccentColor(value)
    ) ?? null;

  const roles: DesignIntent["colorRoles"] = [
    {
      role: "page background",
      value: pageBackgroundValue,
      description: darkFirst ? "Use this as the dominant dark canvas." : "Use this as the dominant light canvas."
    },
    {
      role: "primary text",
      value: primaryTextValue,
      description: "Reserve this for headlines, active controls, and high-emphasis copy."
    },
    {
      role: "muted text",
      value: mutedTextValue,
      description: "Use this for secondary descriptions, nav links, and supporting labels."
    },
    {
      role: "surface",
      value: surfaceValue,
      description: "Use this for translucent panels, inputs, or layered cards."
    }
  ];

  if (accentValue) {
    roles.push({
      role: "accent",
      value: accentValue,
      description: "Use this sparingly for status, highlights, or focused moments."
    });
  }

  return roles;
}

function buildDesignSystem(pages: PageDesignSnapshot[]): DesignSystem {
  const layoutPatternMap = new Map<string, number>();

  for (const page of pages) {
    for (const displayMode of page.layout.displayModes.slice(0, 3)) {
      layoutPatternMap.set(displayMode.value, (layoutPatternMap.get(displayMode.value) ?? 0) + displayMode.count);
    }
  }

  const fontAssetCounts = new Map<string, number>();
  for (const token of mergeTypography(pages.map((page) => page.tokens.typography))) {
    fontAssetCounts.set(token.family, (fontAssetCounts.get(token.family) ?? 0) + token.count);
  }

  return {
    colors: sortColorsForNarrative(mergeCountedValues(pages.map((page) => page.tokens.colors), 12)).slice(0, 12),
    backgrounds: mergeCountedValues(pages.map((page) => page.tokens.backgrounds), 10),
    typography: mergeTypography(pages.map((page) => page.tokens.typography)),
    spacingScale: mergeCountedValues(pages.map((page) => page.tokens.spacingScale), 10),
    radii: mergeCountedValues(pages.map((page) => page.tokens.radii), 8),
    shadows: mergeCountedValues(pages.map((page) => page.tokens.shadows), 8),
    layoutPatterns: [...layoutPatternMap.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([name, count]) => ({
        name,
        count,
        details: [`Observed across analyzed pages as a recurring ${name} pattern.`]
      })),
    fontAssets: [...fontAssetCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([family, count]) => ({
        family,
        source: "computed-style",
        count
      }))
  };
}

function buildDesignIntent(designSystem: DesignSystem, pages: PageDesignSnapshot[]): DesignIntent {
  const colorRoles = buildColorRoles(designSystem);
  const pageBackground = colorRoles.find((role) => role.role === "page background")?.value ?? "rgb(255,255,255)";
  const primaryText = colorRoles.find((role) => role.role === "primary text")?.value ?? "rgb(255,255,255)";
  const mutedText = colorRoles.find((role) => role.role === "muted text")?.value ?? primaryText;
  const darkFirst = isDarkColor(pageBackground);
  const componentKinds = uniqueStrings(pages.flatMap((page) => page.components.map((component) => component.kind)));
  const allComponents = pages.flatMap((page) => page.components);
  const spacingTokens = uniqueStrings(
    designSystem.spacingScale
      .map((item) => parsePxValue(item.value))
      .filter((value): value is number => value !== null)
      .map((value) => {
        const nearest = CANONICAL_SPACING_SCALE.reduce((best, current) =>
          Math.abs(current - value) < Math.abs(best - value) ? current : best
        );
        return `${nearest}px`;
      })
  ).slice(0, 5);
  const hasGlossyLightCta = allComponents.some(
    (component) =>
      (component.kind === "button" || component.kind === "link-button") &&
      component.styleSignature.includes("bg:rgb(230,230,230)")
  );
  const hasGlassPanels =
    allComponents.some((component) => component.cssRules.some((rule) => rule.declarations.some((decl) => decl.property === "backdrop-filter"))) ||
    allComponents.some((component) => component.styleSignature.includes("rgba(255,255,255,0.05)"));

  const visualStyle = uniqueStrings([
    darkFirst ? "Dark-first, high-contrast product surface." : "Light-first product surface with restrained contrast.",
    hasGlossyLightCta ? "Primary actions should feel glossy, bright, and tactile against the darker chrome." : "",
    hasGlassPanels ? "Use translucent panels, thin borders, and soft blur for elevated product surfaces." : "",
    designSystem.fontAssets.some((item) => item.family.includes("sf pro"))
      ? "The overall aesthetic should feel desktop-native rather than generic SaaS marketing."
      : "",
    componentKinds.includes("card") ? "Feature sections should foreground dense product-window demos instead of decorative illustration." : ""
  ]);

  const typography = buildTypographyNarrative(designSystem);
  const spacing = buildSpacingNarrative(designSystem.spacingScale.map((item) => item.value));
  const shape = buildShapeNarrative(designSystem);
  const layout = buildLayoutNarrative(designSystem, pages);
  const componentPatterns = uniqueStrings([
    componentKinds.includes("navbar")
      ? "Navigation should use compact medium-weight links with subtle hover emphasis, not oversized menu chrome."
      : "",
    hasGlossyLightCta
      ? "Primary CTAs should use a light filled button with layered shadows and inset highlights."
      : "",
    componentKinds.includes("card")
      ? "Cards and demo windows should feel dense and product-like, with thin borders and restrained rounding."
      : "",
    componentKinds.includes("input")
      ? "Inputs should sit on darker translucent surfaces with bright, high-contrast submit or action buttons."
      : ""
  ]);

  const prompt = [
    darkFirst ? "Design a dark, desktop-native product UI." : "Design a clean product UI.",
    `Use ${pageBackground} as the dominant page canvas, ${primaryText} for primary text, and ${mutedText} for secondary copy.`,
    hasGlossyLightCta ? "Primary CTAs should be bright, glossy, and tactile." : "",
    hasGlassPanels ? "Use translucent glass-like panels with thin borders and soft blur." : "",
    designSystem.fontAssets[0] ? `Set the main UI typography in ${designSystem.fontAssets[0].family}.` : "",
    designSystem.fontAssets.some((item) => item.family.includes("sf pro"))
      ? "Let product previews borrow native desktop typography."
      : "",
    spacingTokens.length > 0 ? `Keep spacing anchored on ${spacingTokens.join(", ")}.` : "",
    "Favor 6-8px control rounding, layered inset shadows, compact navigation, and dense product-demo sections."
  ]
    .filter(Boolean)
    .join(" ");

  return {
    visualStyle,
    colorRoles,
    typography,
    spacing,
    shape,
    layout,
    componentPatterns,
    prompt
  };
}

function buildCodexBrief(designIntent: DesignIntent): string {
  const colors = designIntent.colorRoles
    .slice(0, 4)
    .map((role) => `${role.role} ${role.value}`)
    .join("; ");
  const typeLead = designIntent.typography.slice(0, 2).join(" ");
  const spacingLead = designIntent.spacing[0] ?? "Use a compact 8px-led spacing rhythm.";
  const shapeLead = designIntent.shape[0] ?? "Keep corners tight and shadows layered.";
  const layoutLead = designIntent.layout[0] ?? "Balance dense product sections with clear content hierarchy.";
  const componentLead = designIntent.componentPatterns.slice(0, 2).join(" ");

  return [designIntent.visualStyle[0], colors, typeLead, spacingLead, shapeLead, layoutLead, componentLead]
    .filter(Boolean)
    .join(" ");
}

function emptyDesignSystem(): DesignSystem {
  return {
    colors: [],
    backgrounds: [],
    typography: [],
    spacingScale: [],
    radii: [],
    shadows: [],
    layoutPatterns: [],
    fontAssets: []
  };
}

function emptyDesignIntent(): DesignIntent {
  return {
    visualStyle: [],
    colorRoles: [],
    typography: [],
    spacing: [],
    shape: [],
    layout: [],
    componentPatterns: [],
    prompt:
      "No design intent could be derived because the browser runtime failed before any page data was collected."
  };
}

function buildFailureMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : "analysis-failed";

  if (rawMessage.includes("libnspr4.so")) {
    return [
      "Playwright Chromium could not start because the system library libnspr4 is missing.",
      "On Ubuntu/Debian, install browser dependencies with `sudo npx playwright install-deps chromium`",
      "or at minimum `sudo apt-get install -y libnspr4 libnss3`, then rerun the command."
    ].join(" ");
  }

  return rawMessage;
}

function createFailureBundle(
  requestedUrl: string,
  pages: PageDesignSnapshot[],
  errors: AnalysisError[],
  resolvedUrl = requestedUrl
): DesignAnalysisBundle {
  const designSystem = pages.length > 0 ? buildDesignSystem(pages) : emptyDesignSystem();
  const designIntent = pages.length > 0 ? buildDesignIntent(designSystem, pages) : emptyDesignIntent();
  const codexBrief =
    pages.length > 0
      ? buildCodexBrief(designIntent)
      : "No design data could be extracted because the browser runtime failed before page analysis began. Inspect the errors array and fix the local Playwright/browser dependency issue first.";

  return designAnalysisBundleSchema.parse({
    schemaVersion: "1.0",
    target: {
      requestedUrl,
      resolvedUrl,
      hostname: new URL(resolvedUrl).hostname,
      analyzedAt: new Date().toISOString()
    },
    viewport: DEFAULT_VIEWPORT,
    codexBrief,
    designSystem,
    designIntent,
    pages,
    errors
  });
}

async function writeBundle(outputDir: string, bundle: DesignAnalysisBundle): Promise<void> {
  await writeFile(path.join(outputDir, "analysis.json"), JSON.stringify(bundle, null, 2), "utf8");
}

function isSameHostFamily(candidateHostname: string, rootHostname: string): boolean {
  return (
    candidateHostname === rootHostname ||
    candidateHostname.endsWith(`.${rootHostname}`) ||
    rootHostname.endsWith(`.${candidateHostname}`)
  );
}

async function collectPageArtifacts(
  browserContext: BrowserContext,
  targetUrl: string,
  outputDir: string,
  timeoutMs: number,
  errors: AnalysisError[]
): Promise<CollectedPageArtifacts> {
  const page = await browserContext.newPage();
  const cssResponses = new Map<string, CapturedCssSource>();
  const rootHostname = new URL(targetUrl).hostname;

  page.on("response", async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] ?? "";
    if (!url.endsWith(".css") && !contentType.includes("text/css")) {
      return;
    }

    if (response.request().frame() !== page.mainFrame()) {
      return;
    }

    try {
      const hostname = new URL(url).hostname;
      if (!isSameHostFamily(hostname, rootHostname)) {
        return;
      }
    } catch {
      return;
    }

    try {
      const text = await response.text();
      cssResponses.set(url, {
        url,
        status: response.status(),
        media: null,
        text
      });
    } catch (error) {
      cssResponses.set(url, {
        url,
        status: response.status(),
        media: null,
        unreadableReason: error instanceof Error ? error.message : "unable-to-read-css"
      });
    }
  });

  try {
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await preparePage(page, timeoutMs);

    const resolvedUrl = page.url();
    const rawDom = await collectRawPageDomData(page);
    const processed = processRawPageData(rawDom);
    const cssSources = [...cssResponses.values()].map((source) => summarizeCssSource(source, processed.components));
    for (const cssSource of cssSources) {
      if (cssSource.unreadableReason) {
        errors.push({
          scope: "css",
          message: cssSource.unreadableReason,
          url: cssSource.url
        });
      }
    }
    const components = attachCssRulesToComponents(processed.components, cssSources);
    const screenshotPath = path.join(outputDir, "screenshots", `${slugifyUrl(resolvedUrl)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      resolvedUrl,
      linkCandidates: rawDom.linkCandidates,
      snapshot: {
        url: resolvedUrl,
        title: rawDom.title || response?.url() || targetUrl,
        screenshotPath: path.relative(outputDir, screenshotPath),
        pageSummary: processed.pageSummary,
        components,
        cssSources,
        layout: processed.layout,
        tokens: processed.tokens
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "page-analysis-failed";
    errors.push({
      scope: "page",
      message,
      url: targetUrl
    });
    throw error;
  } finally {
    await page.close();
  }
}

export async function analyzeSite(input: AnalyzeOptions): Promise<DesignAnalysisBundle> {
  const options = analyzeOptionsSchema.parse(input);
  const outputDir = options.outDir ?? createArtifactDir(path.join(process.cwd(), "artifacts"), options.url);
  const errors: AnalysisError[] = [];
  const pages: PageDesignSnapshot[] = [];
  let resolvedUrl = options.url;

  await ensureDir(outputDir);
  await ensureDir(path.join(outputDir, "screenshots"));

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const message = buildFailureMessage(error);
    errors.push({
      scope: "global",
      message,
      url: options.url
    });
    const bundle = createFailureBundle(options.url, pages, errors, resolvedUrl);
    await writeBundle(outputDir, bundle);
    throw new AnalyzeSiteError(message, bundle, outputDir);
  }

  try {
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT
    });

    try {
      const rootPage = await collectPageArtifacts(context, options.url, outputDir, options.timeoutMs, errors);
      resolvedUrl = rootPage.resolvedUrl;
      const crawlUrls = selectRepresentativeLinks(rootPage.resolvedUrl, rootPage.linkCandidates, options.maxPages);
      pages.push(rootPage.snapshot);

      for (const url of crawlUrls.slice(1)) {
        try {
          const pageArtifacts = await collectPageArtifacts(context, url, outputDir, options.timeoutMs, errors);
          pages.push(pageArtifacts.snapshot);
        } catch {
          continue;
        }
      }

      const bundle = createFailureBundle(options.url, pages, errors, resolvedUrl);
      await writeBundle(outputDir, bundle);
      return bundle;
    } catch (error) {
      const message = buildFailureMessage(error);
      if (!errors.some((entry) => entry.scope === "global" && entry.message === message)) {
        errors.push({
          scope: "global",
          message,
          url: resolvedUrl
        });
      }
      const bundle = createFailureBundle(options.url, pages, errors, resolvedUrl);
      await writeBundle(outputDir, bundle);
      throw new AnalyzeSiteError(message, bundle, outputDir);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
