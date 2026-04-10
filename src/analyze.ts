import { writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext } from "playwright";

import {
  analyzeOptionsSchema,
  designAnalysisBundleSchema,
  type AnalysisError,
  type AnalyzeOptions,
  type DesignAnalysisBundle,
  type DesignSystem,
  type PageDesignSnapshot,
  type TypographyToken
} from "./schema.js";
import { attachCssRulesToComponents, summarizeCssSource, type CapturedCssSource } from "./lib/css.js";
import { collectRawPageDomData, preparePage, processRawPageData } from "./lib/extract.js";
import { createArtifactDir, ensureDir, slugifyUrl } from "./lib/fs.js";
import { selectRepresentativeLinks, type LinkCandidate } from "./lib/links.js";
import { sortColorsForNarrative } from "./lib/style.js";

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

function buildCodexBrief(designSystem: DesignSystem, pages: PageDesignSnapshot[]): string {
  const colors = sortColorsForNarrative(designSystem.colors)
    .slice(0, 4)
    .map((item) => item.value)
    .join(", ") || "neutral tones";
  const typeLead = designSystem.typography
    .slice(0, 3)
    .map((token) => `${token.family} ${token.size}/${token.lineHeight}`)
    .join("; ") || "a restrained sans-serif type system";
  const spacingLead = designSystem.spacingScale.slice(0, 4).map((item) => item.value).join(", ") || "8px-driven spacing";
  const radiiLead = designSystem.radii.slice(0, 3).map((item) => item.value).join(", ") || "soft corners";
  const components = [...new Set(pages.flatMap((page) => page.components.map((component) => component.kind)))]
    .slice(0, 6)
    .join(", ");
  const layoutLead = designSystem.layoutPatterns.slice(0, 3).map((item) => item.name).join(", ") || "block";

  return [
    `Build the UI around dominant colors ${colors}.`,
    `Typography centers on ${typeLead}.`,
    `Use a spacing scale that repeatedly lands on ${spacingLead}.`,
    `Corners and elevation are expressed through radii ${radiiLead} and the captured shadow tokens.`,
    `Primary structural patterns are ${layoutLead}, while the recurring component language includes ${components || "hero, navigation, and content blocks"}.`,
    "Prefer the captured component selectors and CSS summaries as guidance for recreating button, card, section, and navigation styling."
  ].join(" ");
}

function emptyDesignSystem(): DesignSystem {
  return {
    colors: [],
    typography: [],
    spacingScale: [],
    radii: [],
    shadows: [],
    layoutPatterns: [],
    fontAssets: []
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
  const codexBrief =
    pages.length > 0
      ? buildCodexBrief(designSystem, pages)
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
    pages,
    errors
  });
}

async function writeBundle(outputDir: string, bundle: DesignAnalysisBundle): Promise<void> {
  await writeFile(path.join(outputDir, "analysis.json"), JSON.stringify(bundle, null, 2), "utf8");
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

  page.on("response", async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] ?? "";
    if (!url.endsWith(".css") && !contentType.includes("text/css")) {
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
