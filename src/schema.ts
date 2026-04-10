import { z } from "zod";

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const boundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
});

export const countedValueSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
  usage: z.array(z.string()).default([])
});

export const typographyTokenSchema = z.object({
  family: z.string(),
  size: z.string(),
  weight: z.string(),
  lineHeight: z.string(),
  count: z.number().int().nonnegative()
});

export const layoutPatternSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  details: z.array(z.string()).default([])
});

export const fontAssetSchema = z.object({
  family: z.string(),
  source: z.string(),
  count: z.number().int().nonnegative()
});

export const cssDeclarationSchema = z.object({
  property: z.string(),
  value: z.string()
});

export const cssRuleSummarySchema = z.object({
  selector: z.string(),
  declarations: z.array(cssDeclarationSchema),
  media: z.string().nullable().default(null)
});

export const cssSourceSummarySchema = z.object({
  url: z.string().url(),
  media: z.string().nullable().default(null),
  status: z.number().int(),
  unreadableReason: z.string().nullable().default(null),
  customProperties: z.array(cssDeclarationSchema).default([]),
  matchedRules: z.array(cssRuleSummarySchema).default([])
});

export const componentExampleSchema = z.object({
  kind: z.string(),
  tagName: z.string(),
  selectorHint: z.string(),
  classList: z.array(z.string()).default([]),
  textSnippet: z.string(),
  htmlSnippet: z.string(),
  boundingBox: boundingBoxSchema,
  styleSignature: z.string(),
  cssRules: z.array(cssRuleSummarySchema).default([])
});

export const pageLayoutSchema = z.object({
  displayModes: z.array(countedValueSchema).default([]),
  containerWidths: z.array(countedValueSchema).default([]),
  sectionSpacing: z.array(countedValueSchema).default([]),
  dominantGapValues: z.array(countedValueSchema).default([]),
  notes: z.array(z.string()).default([])
});

export const pageTokensSchema = z.object({
  colors: z.array(countedValueSchema).default([]),
  typography: z.array(typographyTokenSchema).default([]),
  spacingScale: z.array(countedValueSchema).default([]),
  radii: z.array(countedValueSchema).default([]),
  shadows: z.array(countedValueSchema).default([]),
  backgrounds: z.array(countedValueSchema).default([])
});

export const pageDesignSnapshotSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  screenshotPath: z.string(),
  pageSummary: z.string(),
  components: z.array(componentExampleSchema),
  cssSources: z.array(cssSourceSummarySchema),
  layout: pageLayoutSchema,
  tokens: pageTokensSchema
});

export const designSystemSchema = z.object({
  colors: z.array(countedValueSchema).default([]),
  backgrounds: z.array(countedValueSchema).default([]),
  typography: z.array(typographyTokenSchema).default([]),
  spacingScale: z.array(countedValueSchema).default([]),
  radii: z.array(countedValueSchema).default([]),
  shadows: z.array(countedValueSchema).default([]),
  layoutPatterns: z.array(layoutPatternSchema).default([]),
  fontAssets: z.array(fontAssetSchema).default([])
});

export const designIntentColorRoleSchema = z.object({
  role: z.string(),
  value: z.string(),
  description: z.string()
});

export const designIntentSchema = z.object({
  visualStyle: z.array(z.string()).default([]),
  colorRoles: z.array(designIntentColorRoleSchema).default([]),
  typography: z.array(z.string()).default([]),
  spacing: z.array(z.string()).default([]),
  shape: z.array(z.string()).default([]),
  layout: z.array(z.string()).default([]),
  componentPatterns: z.array(z.string()).default([]),
  prompt: z.string()
});

export const analysisErrorSchema = z.object({
  scope: z.enum(["global", "page", "css"]),
  message: z.string(),
  url: z.string().url().nullable().default(null)
});

export const targetSchema = z.object({
  requestedUrl: z.string().url(),
  resolvedUrl: z.string().url(),
  hostname: z.string(),
  analyzedAt: z.string()
});

export const analyzeOptionsSchema = z.object({
  url: z.string().url(),
  outDir: z.string().optional(),
  maxPages: z.number().int().positive().max(10).default(5),
  timeoutMs: z.number().int().positive().default(30_000)
});

export const designAnalysisBundleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  target: targetSchema,
  viewport: viewportSchema,
  codexBrief: z.string(),
  designSystem: designSystemSchema,
  designIntent: designIntentSchema,
  pages: z.array(pageDesignSnapshotSchema),
  errors: z.array(analysisErrorSchema)
});

export type Viewport = z.infer<typeof viewportSchema>;
export type BoundingBox = z.infer<typeof boundingBoxSchema>;
export type CountedValue = z.infer<typeof countedValueSchema>;
export type TypographyToken = z.infer<typeof typographyTokenSchema>;
export type LayoutPattern = z.infer<typeof layoutPatternSchema>;
export type FontAsset = z.infer<typeof fontAssetSchema>;
export type CssDeclaration = z.infer<typeof cssDeclarationSchema>;
export type CssRuleSummary = z.infer<typeof cssRuleSummarySchema>;
export type CssSourceSummary = z.infer<typeof cssSourceSummarySchema>;
export type ComponentExample = z.infer<typeof componentExampleSchema>;
export type PageLayout = z.infer<typeof pageLayoutSchema>;
export type PageTokens = z.infer<typeof pageTokensSchema>;
export type PageDesignSnapshot = z.infer<typeof pageDesignSnapshotSchema>;
export type DesignSystem = z.infer<typeof designSystemSchema>;
export type DesignIntentColorRole = z.infer<typeof designIntentColorRoleSchema>;
export type DesignIntent = z.infer<typeof designIntentSchema>;
export type AnalysisError = z.infer<typeof analysisErrorSchema>;
export type AnalyzeOptions = z.infer<typeof analyzeOptionsSchema>;
export type DesignAnalysisBundle = z.infer<typeof designAnalysisBundleSchema>;
