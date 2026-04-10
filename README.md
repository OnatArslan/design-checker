# design-checker

Analyze a public website and emit Codex-friendly frontend design artifacts.

The package crawls a small set of same-origin pages with Playwright, captures screenshots, extracts design tokens and component examples, and writes an `analysis.json` bundle that is meant to be useful for design-aware code generation.

## Requirements

- Node.js 20+
- Playwright Chromium runtime

Install browser binaries if you have not already:

```bash
npx playwright install chromium
```

Some Linux systems also need Playwright browser dependencies:

```bash
sudo npx playwright install-deps chromium
```

## Install

Use it without installing globally:

```bash
npx design-checker analyze https://www.raycast.com
```

Or install it:

```bash
npm install -g design-checker
design-checker analyze https://www.raycast.com
```

## CLI

```bash
npm run build
❯ node dist/cli.js analyze https://www.example.com/ --out ./artifacts/example --max-pages 5 --timeout 30000
```

```bash
design-checker analyze <url> [--out <dir>] [--max-pages <number>] [--timeout <ms>]
```

Example:

```bash
design-checker analyze https://www.raycast.com --out ./artifacts/raycast --max-pages 5 --timeout 30000
```

The CLI prints the final JSON bundle to stdout and also writes artifacts to disk.

## Library Usage

```ts
import { analyzeSite } from "design-checker";

const bundle = await analyzeSite({
  url: "https://www.raycast.com",
  outDir: "./artifacts/raycast",
  maxPages: 5,
  timeoutMs: 30_000
});

console.log(bundle.codexBrief);
console.log(bundle.designIntent.prompt);
```

## Output

The output directory contains:

```text
artifacts/<hostname>-<timestamp>/
  analysis.json
  screenshots/
    home.png
    pricing.png
    ...
```

Important top-level fields in `analysis.json`:

- `codexBrief`: short compressed summary for prompt context
- `designIntent`: structured design guidance, including a ready-to-use `prompt`
- `designSystem`: aggregated raw token telemetry
- `pages`: per-page snapshots, component examples, matched CSS, and screenshots
- `errors`: crawl or extraction failures that did not fully abort the run

## Publish Notes

This package is built for server or local Node environments. It is not a browser-only package because the analysis depends on Playwright and filesystem artifact generation.

## Development

```bash
npm install
npm run build
npm test
```

Before `npm publish`, the package now performs a clean rebuild via `prepack`, and tests run via `prepublishOnly`.
