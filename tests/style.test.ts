import { describe, expect, test } from "vitest";

import {
  buildStyleSignature,
  normalizeColor,
  normalizeContainerWidthToken,
  normalizeFontFamily,
  normalizeLength,
  normalizeRadiusToken,
  normalizeSpacingToken
} from "../src/lib/style.js";

describe("style normalization", () => {
  test("produces stable style signatures for equivalent computed styles", () => {
    const signatureA = buildStyleSignature({
      fontFamily: '"Space Grotesk", Arial, sans-serif',
      fontSize: "16px",
      fontWeight: "600",
      lineHeight: "24px",
      color: "rgb(10, 20, 30)",
      backgroundColor: "rgba(255, 255, 255, 1)",
      borderRadius: "12.0px",
      boxShadow: "rgba(15, 23, 42, 0.08) 0px 12px 30px 0px",
      paddingTop: "12px",
      paddingLeft: "24px",
      display: "inline-flex"
    });

    const signatureB = buildStyleSignature({
      fontFamily: "space grotesk, Arial , sans-serif",
      fontSize: "16.00px",
      fontWeight: "600",
      lineHeight: "24.0px",
      color: "rgb(10,20,30)",
      backgroundColor: "rgba(255,255,255,1)",
      borderRadius: "12px",
      boxShadow: "rgba(15, 23, 42, 0.08) 0px 12px 30px 0px",
      paddingTop: "12px",
      paddingLeft: "24px",
      display: "inline-flex"
    });

    expect(signatureA).toBe(signatureB);
  });

  test("normalizes primitive style values", () => {
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(normalizeFontFamily('"IBM Plex Sans", sans-serif')).toBe("ibm plex sans, sans-serif");
    expect(normalizeLength("12.50px")).toBe("12.5px");
  });

  test("filters noisy spacing, radius, and container tokens", () => {
    expect(normalizeSpacingToken("normal")).toBeNull();
    expect(normalizeSpacingToken("12px")).toBe("12px");
    expect(normalizeRadiusToken("3.35544e+07px")).toBe("pill");
    expect(normalizeContainerWidthToken("none")).toBeNull();
    expect(normalizeContainerWidthToken("1320px")).toBe("1320px");
  });
});
