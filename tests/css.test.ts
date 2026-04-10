import { describe, expect, test } from "vitest";

import { summarizeCssSource } from "../src/lib/css.js";
import type { ComponentExample } from "../src/schema.js";

describe("css summarization", () => {
  test("extracts matched rules and root custom properties", () => {
    const component: ComponentExample = {
      kind: "button",
      tagName: "button",
      selectorHint: "div.hero > button.cta",
      classList: ["cta"],
      textSnippet: "Start project",
      htmlSnippet: '<button class="cta">Start project</button>',
      boundingBox: {
        x: 0,
        y: 0,
        width: 160,
        height: 48
      },
      styleSignature: "font:space grotesk | size:16px",
      cssRules: []
    };

    const summary = summarizeCssSource(
      {
        url: "https://example.com/styles.css",
        media: null,
        status: 200,
        text: `
          :root { --accent: #ff6a3d; --surface: #f6efe8; }
          .hero .cta, button.cta { background: var(--accent); color: white; padding: 12px 24px; }
          @media (max-width: 800px) {
            .cta { padding: 10px 20px; }
          }
        `
      },
      [component]
    );

    expect(summary.customProperties).toContainEqual({ property: "--accent", value: "#ff6a3d" });
    expect(summary.matchedRules.some((rule) => rule.selector.includes(".cta"))).toBe(true);
    expect(summary.matchedRules.some((rule) => rule.media === "(max-width: 800px)")).toBe(true);
  });

  test("does not match unrelated rules via generic tag names", () => {
    const component: ComponentExample = {
      kind: "link-button",
      tagName: "a",
      selectorHint: "header > a.cta-link",
      classList: ["cta-link", "px-4"],
      textSnippet: "Docs",
      htmlSnippet: '<a class="cta-link px-4">Docs</a>',
      boundingBox: {
        x: 0,
        y: 0,
        width: 120,
        height: 40
      },
      styleSignature: "font:geist | size:14px",
      cssRules: []
    };

    const summary = summarizeCssSource(
      {
        url: "https://example.com/styles.css",
        media: null,
        status: 200,
        text: `
          .rich-text-editor a { color: red; }
          .cta-link { color: white; background: black; }
        `
      },
      [component]
    );

    expect(summary.matchedRules).toHaveLength(1);
    expect(summary.matchedRules[0]?.selector).toBe(".cta-link");
  });
});
