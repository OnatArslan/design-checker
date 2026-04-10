import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { analyzeSite } from "../src/analyze.js";
import { startFixtureServer } from "./helpers/server.js";

const fixtureDir = path.resolve("tests/fixtures/site");

describe("analyzeSite integration", () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
  let serverStartupError: Error | undefined;
  let browserStartupError: Error | undefined;

  beforeAll(async () => {
    try {
      server = await startFixtureServer(fixtureDir);
    } catch (error) {
      serverStartupError = error instanceof Error ? error : new Error("Failed to start fixture server.");
    }

    if (!serverStartupError) {
      try {
        const browser = await chromium.launch({ headless: true });
        await browser.close();
      } catch (error) {
        browserStartupError = error instanceof Error ? error : new Error("Failed to launch Playwright browser.");
      }
    }
  }, 30_000);

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  test("produces analysis artifacts for a local marketing site", async (context) => {
    if (serverStartupError) {
      context.skip(`Fixture server unavailable: ${serverStartupError.message}`);
      return;
    }

    if (browserStartupError) {
      context.skip(`Playwright browser unavailable: ${browserStartupError.message}`);
      return;
    }

    const outDir = await mkdtemp(path.join(os.tmpdir(), "design-checker-"));

    try {
      const bundle = await analyzeSite({
        url: `${server!.baseUrl}/`,
        outDir,
        maxPages: 4,
        timeoutMs: 3_000
      });

      expect(bundle.pages.length).toBeGreaterThanOrEqual(3);
      expect(bundle.designSystem.colors.length).toBeGreaterThan(0);
      expect(bundle.designIntent.prompt.length).toBeGreaterThan(0);
      expect(bundle.codexBrief.length).toBeGreaterThan(40);
      expect(existsSync(path.join(outDir, "analysis.json"))).toBe(true);

      const analysisFile = JSON.parse(await readFile(path.join(outDir, "analysis.json"), "utf8"));
      expect(analysisFile.schemaVersion).toBe("1.0");
      expect(analysisFile.designIntent.prompt).toBeTypeOf("string");

      for (const page of bundle.pages) {
        expect(existsSync(path.join(outDir, page.screenshotPath))).toBe(true);
      }

      const kinds = bundle.pages.flatMap((page) => page.components.map((component) => component.kind));
      expect(kinds).toContain("card");
      expect(kinds).toContain("footer");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("keeps partial output and surfaces css/page failures", async (context) => {
    if (serverStartupError) {
      context.skip(`Fixture server unavailable: ${serverStartupError.message}`);
      return;
    }

    if (browserStartupError) {
      context.skip(`Playwright browser unavailable: ${browserStartupError.message}`);
      return;
    }

    const outDir = await mkdtemp(path.join(os.tmpdir(), "design-checker-"));

    try {
      const bundle = await analyzeSite({
        url: `${server!.baseUrl}/`,
        outDir,
        maxPages: 4,
        timeoutMs: 150
      });

      expect(bundle.pages.length).toBeGreaterThanOrEqual(1);
      expect(bundle.errors.some((error) => error.scope === "page")).toBe(true);
      expect(bundle.errors.some((error) => error.scope === "css")).toBe(true);
      expect(existsSync(path.join(outDir, "analysis.json"))).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
