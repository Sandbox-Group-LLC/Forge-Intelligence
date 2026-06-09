// Data-driven reel schema. This is the contract between the Forge backend
// (storyboard agent + TTS) and the Remotion render. inputProps passed to
// renderMediaOnLambda must match VideoProps.

export type Brand = {
  name: string;
  // Any subset overrides the Forge defaults in DataReel's palette.
  colors?: Partial<{
    bg: string; card: string; accent: string; accent2: string;
    emphasis: string; secondary: string; muted: string;
    error: string; success: string; border: string;
  }>;
  // Measured logo URL (S3/og:image/favicon). When present it replaces the
  // Forge diamond in the lockup + closing card.
  logo?: string;
};

type SceneBase = {
  id: string;
  // Total frames this scene occupies. At generation time this is derived from
  // the VO clip length (audioDurationSec * fps) plus a small tail.
  durationInFrames: number;
  // Per-scene voiceover. Full https URL (S3) → used as-is; bare filename →
  // resolved via staticFile("audio/<name>") for local renders.
  audio?: string;
};

export type HookScene = SceneBase & {
  type: "hook";
  eyebrow?: string;
  headline: string;       // supports a single {{em}} span via `emphasis`
  emphasis?: string;      // appended as a colored second line if present
  sub?: string;
};

export type TagsScene = SceneBase & {
  type: "tags";
  headline: string;
  tags: string[];
};

export type OrbitScene = SceneBase & {
  type: "orbit";
  centerLabel: string;    // e.g. "Brand\nBrain" (\n splits lines)
  facets: string[];
  caption?: string;
  captionEmphasis?: string;
};

export type PipelineScene = SceneBase & {
  type: "pipeline";
  headline: string;
  headlineEmphasis?: string;
  stages: string[];
  highlightLast?: boolean;
};

export type BarsScene = SceneBase & {
  type: "bars";
  headline: string;
  headlineEmphasis?: string;
  bars: { label: string; pct: number }[];
  footnoteLabel?: string;
  footnoteChips?: string[];
};

export type CurveScene = SceneBase & {
  type: "curve";
  headline: string;
  headlineEmphasis?: string;
  flatLabel?: string;
};

export type CtaScene = SceneBase & {
  type: "cta";
  title: string;
  sub?: string;
  cta: string;
};

export type Scene =
  | HookScene | TagsScene | OrbitScene | PipelineScene
  | BarsScene | CurveScene | CtaScene;

// landscape = 1920x1080 (16:9), portrait = 1080x1920 (9:16, IG reel).
export type Orientation = "landscape" | "portrait";

// Visual themes — template-level styles (palette, typography, motion physics).
// clean = the original light look; editorial = serif luxury; bold = dark canvas,
// huge type; kinetic = springy and fast.
export type ThemeId = "clean" | "editorial" | "bold" | "kinetic";

// Background music bed. src is a presigned S3 URL to a curated instrumental
// (~47s, looped). The template ducks it under the per-scene voiceover.
export type Music = {
  src: string;
};

export type VideoProps = {
  brand: Brand;
  scenes: Scene[];
  fontFamily?: string;
  orientation?: Orientation;
  music?: Music | null;
  theme?: ThemeId;
};
