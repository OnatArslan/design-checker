export type LinkCandidate = {
  url: string;
  text: string;
  zone: "header" | "nav" | "main" | "footer" | "other";
  area: number;
};

const LOW_VALUE_SEGMENTS = [
  "privacy",
  "terms",
  "legal",
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "logout",
  "auth",
  "account",
  "cookie",
  "preferences"
];

const HIGH_SIGNAL_SEGMENTS = [
  "about",
  "pricing",
  "product",
  "services",
  "features",
  "contact",
  "work",
  "portfolio",
  "solutions"
];

export function normalizePathTemplate(urlString: string): string {
  const url = new URL(urlString);
  const normalizedSegments = url.pathname
    .replace(/\/+/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (/^\d{2,}$/.test(segment)) {
        return ":id";
      }

      if (/^(?=.*\d)[0-9a-z-]{8,}$/i.test(segment)) {
        return ":id";
      }

      return segment;
    });

  return `/${normalizedSegments.join("/")}`.replace(/\/$/, "");
}

export function isLowValuePath(urlString: string): boolean {
  const url = new URL(urlString);
  const path = `${url.pathname}${url.search}`.toLowerCase();
  return LOW_VALUE_SEGMENTS.some((segment) => path.includes(segment));
}

function scoreCandidate(candidate: LinkCandidate, origin: string): number {
  const url = new URL(candidate.url);
  if (url.origin !== origin) {
    return Number.NEGATIVE_INFINITY;
  }

  if (!url.pathname || url.hash) {
    return Number.NEGATIVE_INFINITY;
  }

  if (isLowValuePath(candidate.url)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  score += Math.min(candidate.area / 40_000, 1.5);

  if (candidate.zone === "header") {
    score += 3.25;
  } else if (candidate.zone === "nav") {
    score += 3;
  } else if (candidate.zone === "main") {
    score += 1.25;
  } else if (candidate.zone === "footer") {
    score -= 1.5;
  }

  const lowerPath = url.pathname.toLowerCase();
  if (HIGH_SIGNAL_SEGMENTS.some((segment) => lowerPath.includes(segment))) {
    score += 3;
  }

  if (candidate.text.length >= 4 && candidate.text.length <= 28) {
    score += 1;
  }

  const depth = lowerPath.split("/").filter(Boolean).length;
  score += Math.max(0, 2 - depth);

  return score;
}

export function selectRepresentativeLinks(
  rootUrl: string,
  candidates: LinkCandidate[],
  maxPages: number
): string[] {
  const root = new URL(rootUrl);
  const origin = root.origin;
  const normalizedRoot = new URL(rootUrl).toString();
  const uniqueCandidates = new Map<string, LinkCandidate>();

  for (const candidate of candidates) {
    const normalizedUrl = new URL(candidate.url, normalizedRoot);
    normalizedUrl.hash = "";
    const href = normalizedUrl.toString();

    if (href === normalizedRoot || href === `${normalizedRoot}/`) {
      continue;
    }

    if (!uniqueCandidates.has(href)) {
      uniqueCandidates.set(href, { ...candidate, url: href });
    }
  }

  const scored = [...uniqueCandidates.values()]
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, origin) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.candidate.url.localeCompare(right.candidate.url));

  const selected = [normalizedRoot];
  const usedTemplates = new Set<string>([normalizePathTemplate(normalizedRoot)]);

  for (const entry of scored) {
    if (selected.length >= maxPages) {
      break;
    }

    const template = normalizePathTemplate(entry.candidate.url);
    if (usedTemplates.has(template)) {
      continue;
    }

    usedTemplates.add(template);
    selected.push(entry.candidate.url);
  }

  return selected;
}
