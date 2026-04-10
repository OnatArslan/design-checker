import postcss from "postcss";

import type { ComponentExample, CssDeclaration, CssRuleSummary, CssSourceSummary } from "../schema.js";

type SelectorToken = {
  selector: string;
  score: number;
};

export type CapturedCssSource = {
  url: string;
  media: string | null;
  status: number;
  text?: string;
  unreadableReason?: string | null;
};

const GENERIC_CLASS_NAMES = new Set([
  "absolute",
  "block",
  "container",
  "flex",
  "grid",
  "group",
  "hidden",
  "inline",
  "inline-flex",
  "relative",
  "sticky"
]);

const GENERIC_IDS = new Set(["root", "__next", "app"]);
const LOW_SIGNAL_SELECTORS = new Set(["#root", ".hide-scrollbars", ".hide-scrollbars::-webkit-scrollbar"]);

const UTILITY_PREFIX_RE =
  /^(?:[mp][trblxy]?|[wh]|min-w|min-h|max-w|max-h|gap|space-[xy]|text|font|leading|tracking|rounded|border|bg|object|overflow|items|justify|content|self|place|top|right|bottom|left|z|col|row|flex|grid|inline|block|hidden|sticky|absolute|relative|fixed|shrink|grow|basis)(?:[-:[#/.\d]|$)/;
const VARIANT_PREFIX_RE =
  /^(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|dark|group-hover|group-focus|peer-hover|peer-focus|visited|first|last|odd|even|motion-safe|motion-reduce|aria-[^:]+|data-[^:]+):/;

function cssEscapeIdentifier(value: string): string {
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, leadingDigit: string | undefined) => {
    if (leadingDigit) {
      return `\\3${leadingDigit} `;
    }
    return `\\${match}`;
  });
}

function stripVariantPrefixes(className: string): string {
  let current = className;
  while (VARIANT_PREFIX_RE.test(current)) {
    current = current.replace(VARIANT_PREFIX_RE, "");
  }
  return current;
}

function shouldIncludeClassToken(className: string): boolean {
  if (!className || GENERIC_CLASS_NAMES.has(className)) {
    return false;
  }

  const baseClassName = stripVariantPrefixes(className);

  if (/__/.test(baseClassName)) {
    return true;
  }

  if (UTILITY_PREFIX_RE.test(baseClassName)) {
    return false;
  }

  if (/[:[\]/#.%]/.test(baseClassName)) {
    return baseClassName.length >= 10;
  }

  return baseClassName.length >= 3;
}

function classTokenScore(className: string): number {
  const baseClassName = stripVariantPrefixes(className);
  let score = Math.min(baseClassName.length, 18);

  if (baseClassName.includes("__")) {
    score += 8;
  }
  if (/[[:\]/#.%]/.test(baseClassName)) {
    score += 6;
  }
  if (baseClassName.startsWith("bg-") || baseClassName.startsWith("text-") || baseClassName.startsWith("rounded-")) {
    score += 2;
  }

  return score;
}

function buildComponentTokens(component: ComponentExample): SelectorToken[] {
  const tokens = new Map<string, number>();

  if (component.selectorHint.includes("#")) {
    const ids = component.selectorHint.match(/#([A-Za-z0-9_-]+)/g) ?? [];
    ids.forEach((idSelector) => {
      const idValue = idSelector.slice(1).toLowerCase();
      if (!GENERIC_IDS.has(idValue)) {
        tokens.set(idSelector, 30);
      }
    });
  }

  component.classList.filter(shouldIncludeClassToken).forEach((className) => {
    tokens.set(`.${cssEscapeIdentifier(className)}`, classTokenScore(className));
  });

  return [...tokens.entries()].map(([selector, score]) => ({ selector, score }));
}

function selectorMatchScore(selector: string, tokens: SelectorToken[]): number {
  let score = 0;

  for (const token of tokens) {
    if (selector.includes(token.selector)) {
      score = Math.max(score, token.score);
    }
  }

  return score;
}

function isLowSignalMatchedRule(selector: string): boolean {
  if (LOW_SIGNAL_SELECTORS.has(selector)) {
    return true;
  }

  const trimmed = selector.trim();
  return trimmed === ":root" || trimmed === "html" || trimmed === "body";
}

function summarizeDeclarations(input: string[]): CssDeclaration[] {
  const parsed = input.map((line) => {
    const [property, ...rest] = line.split(":");
    return {
      property: property.trim(),
      value: rest.join(":").trim()
    };
  });

  const byProperty = new Map<string, CssDeclaration>();

  for (const declaration of parsed) {
    const existing = byProperty.get(declaration.property);
    const nextIsPreferred = !/^(?:lab|oklab)\(/.test(declaration.value);
    const existingIsPreferred = existing ? !/^(?:lab|oklab)\(/.test(existing.value) : false;

    if (!existing || (nextIsPreferred && !existingIsPreferred)) {
      byProperty.set(declaration.property, declaration);
    }
  }

  return [...byProperty.values()].slice(0, 8);
}

function isRootLikeSelector(selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some((part) => [":root", "html", "body"].includes(part));
}

export function summarizeCssSource(
  source: CapturedCssSource,
  components: ComponentExample[]
): CssSourceSummary {
  const baseSummary: CssSourceSummary = {
    url: source.url,
    media: source.media ?? null,
    status: source.status,
    unreadableReason: source.unreadableReason ?? null,
    customProperties: [],
    matchedRules: []
  };

  if (!source.text || source.unreadableReason) {
    return baseSummary;
  }

  try {
    const root = postcss.parse(source.text, { from: source.url });
    const selectorTokens = components.flatMap(buildComponentTokens);
    const matchedRuleCandidates: Array<CssRuleSummary & { score: number }> = [];
    const customProperties = new Map<string, string>();

    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule") {
        return;
      }

      const declarations: string[] = [];
      rule.walkDecls((decl) => {
        const serialized = `${decl.prop}: ${decl.value}`;
        declarations.push(serialized);

        if (decl.prop.startsWith("--") && isRootLikeSelector(rule.selector)) {
          customProperties.set(decl.prop, decl.value);
        }
      });

      const selector = rule.selector.trim();
      const score = selector ? selectorMatchScore(selector, selectorTokens) : 0;
      if (selector && score > 0 && !isLowSignalMatchedRule(selector)) {
        matchedRuleCandidates.push({
          selector,
          declarations: summarizeDeclarations(declarations),
          media: null,
          score
        });
      }
    });

    root.walkAtRules("media", (atRule) => {
      atRule.walkRules((rule) => {
        const declarations: string[] = [];
        rule.walkDecls((decl) => {
          declarations.push(`${decl.prop}: ${decl.value}`);
        });

        const selector = rule.selector.trim();
        const score = selector ? selectorMatchScore(selector, selectorTokens) : 0;
        if (selector && score > 0 && !isLowSignalMatchedRule(selector)) {
          matchedRuleCandidates.push({
            selector,
            declarations: summarizeDeclarations(declarations),
            media: atRule.params.trim(),
            score
          });
        }
      });
    });

    const matchedRules = [...matchedRuleCandidates]
      .sort((left, right) => right.score - left.score || left.selector.length - right.selector.length)
      .filter(
        (rule, index, array) =>
          array.findIndex((entry) => entry.selector === rule.selector && entry.media === rule.media) === index
      )
      .slice(0, 10)
      .map(({ score: _score, ...rule }) => rule);

    return {
      ...baseSummary,
      matchedRules,
      customProperties: [...customProperties.entries()].slice(0, 12).map(([property, value]) => ({
        property,
        value
      }))
    };
  } catch (error) {
    return {
      ...baseSummary,
      unreadableReason: error instanceof Error ? error.message : "css-parse-failed"
    };
  }
}

export function attachCssRulesToComponents(
  components: ComponentExample[],
  cssSources: CssSourceSummary[]
): ComponentExample[] {
  return components.map((component) => {
    const tokens = buildComponentTokens(component);
    const cssRules = cssSources
      .flatMap((source) => source.matchedRules)
      .map((rule) => ({
        rule,
        score: selectorMatchScore(rule.selector, tokens)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.rule.selector.length - right.rule.selector.length)
      .map((entry) => entry.rule)
      .slice(0, 4);

    return {
      ...component,
      cssRules
    };
  });
}
