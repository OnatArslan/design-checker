import { describe, expect, test } from "vitest";

import { normalizePathTemplate, selectRepresentativeLinks } from "../src/lib/links.js";

describe("link selection", () => {
  test("prefers same-origin, high-signal, unique templates", () => {
    const selected = selectRepresentativeLinks(
      "https://example.com/",
      [
        { url: "https://example.com/pricing", text: "Pricing", zone: "nav", area: 4_000 },
        { url: "https://example.com/about", text: "About", zone: "nav", area: 3_200 },
        { url: "https://example.com/work", text: "Work", zone: "main", area: 22_000 },
        { url: "https://example.com/privacy", text: "Privacy", zone: "footer", area: 2_000 },
        { url: "https://external.example.org/demo", text: "External", zone: "main", area: 30_000 },
        { url: "https://example.com/blog/12345", text: "Case Study", zone: "main", area: 16_000 },
        { url: "https://example.com/blog/67890", text: "Case Study 2", zone: "main", area: 15_500 }
      ],
      4
    );

    expect(selected).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/about",
      "https://example.com/work"
    ]);
  });

  test("normalizes dynamic path segments into a template", () => {
    expect(normalizePathTemplate("https://example.com/blog/12345/abcdef123456")).toBe("/blog/:id/:id");
  });
});
