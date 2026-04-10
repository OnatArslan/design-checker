import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function slugifyUrl(input: string): string {
  const url = new URL(input);
  const pathname = url.pathname === "/" ? "home" : url.pathname.replace(/^\/+/, "");
  const joined = `${pathname}${url.search}`.replace(/[/?&=]+/g, "-");
  return joined.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "page";
}

export function createArtifactDir(baseDir: string, targetUrl: string, now = new Date()): string {
  const hostname = new URL(targetUrl).hostname.replace(/[^a-zA-Z0-9.-]+/g, "-");
  return path.join(baseDir, `${hostname}-${formatTimestamp(now)}`);
}
