#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";

import { AnalyzeSiteError, analyzeSite } from "./analyze.js";

const program = new Command();

program
  .name("design-checker")
  .description("Analyze a website and emit Codex-friendly design artifacts.");

program
  .command("analyze")
  .argument("<url>", "Target URL to analyze")
  .option("--out <dir>", "Output directory for artifacts")
  .option("--max-pages <number>", "Maximum same-origin pages to inspect", "5")
  .option("--timeout <ms>", "Navigation timeout in milliseconds", "30000")
  .action(async (url, options) => {
    const outDir = options.out ? path.resolve(options.out) : undefined;
    const maxPages = Number.parseInt(options.maxPages, 10);
    const timeoutMs = Number.parseInt(options.timeout, 10);

    const bundle = await analyzeSite({
      url,
      outDir,
      maxPages,
      timeoutMs
    });

    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof AnalyzeSiteError) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(`Analysis artifact written to ${error.analysisPath}\n`);
    process.exitCode = 1;
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
