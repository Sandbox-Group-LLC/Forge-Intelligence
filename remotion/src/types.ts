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

// Product showcase: real screenshots of the brand's live site/app, captured by
// the backend (captureProductShots) and uploaded to S3. `shots` are full https
// URLs; the view frames them in browser chrome, held static (no zoom), and
// crossfades if more than one. Copy (eyebrow/headline/stat) is written by the
// storyboard agent; `shots` + `urlLabel` are filled server-side.
export type ScreensScene = SceneBase & {
  type: "screens";
  eyebrow?: string;
  headline: string;
  headlineEmphasis?: string;
  stat?: { value: string; label: string };
  shots: string[];      // S3 URLs (filled by the backend)
  urlLabel?: string;    // address-bar text, e.g. "acme.com"
};

// ── Expanded scene deck (more variety, less recycling) ──────────────────────
export type BigStatScene = SceneBase & {
  type: "bigstat";
  stat: { value: string; label: string };
  sub?: string;
};
export type StatTrioScene = SceneBase & {
  type: "stattrio";
  headline?: string;
  stats: { value: string; label: string }[]; // 2-3
};
export type QuoteScene = SceneBase & {
  type: "quote";
  quote: string;
  attribution?: { name: string; role?: string };
};
export type ComparisonScene = SceneBase & {
  type: "comparison";
  headline?: string;
  headlineEmphasis?: string;
  left: { label: string; items: string[] };   // the old/their way (✕)
  right: { label: string; items: string[] };   // your way (✓, accent)
};
export type StepsScene = SceneBase & {
  type: "steps";
  headline?: string;
  headlineEmphasis?: string;
  steps: { title: string; detail?: string }[]; // numbered 1..n
};
export type GridScene = SceneBase & {
  type: "grid";
  headline?: string;
  headlineEmphasis?: string;
  items: { title: string; detail?: string }[]; // 2-4 feature cells
};
export type TimelineScene = SceneBase & {
  type: "timeline";
  headline?: string;
  headlineEmphasis?: string;
  milestones: { label: string; when?: string }[];
};
export type StatementScene = SceneBase & {
  type: "statement";
  headline: string;     // full-bleed accent gradient, white type — one bold beat
  emphasis?: string;
};
export type LogosScene = SceneBase & {
  type: "logos";
  label?: string;       // e.g. "Trusted by"
  names: string[];      // client/brand names rendered as a wordmark row
};
export type ChecklistScene = SceneBase & {
  type: "checklist";
  headline?: string;
  headlineEmphasis?: string;
  items: string[];      // accent-checked list (deliverables / what you get)
};
export type SplitScene = SceneBase & {
  type: "split";
  headline: string;     // asymmetric: big headline left, supporting points right
  headlineEmphasis?: string;
  points: string[];
};

export type Scene =
  | HookScene | TagsScene | OrbitScene | PipelineScene
  | BarsScene | CurveScene | CtaScene | ScreensScene
  | BigStatScene | StatTrioScene | QuoteScene | ComparisonScene
  | StepsScene | GridScene | TimelineScene | StatementScene
  | LogosScene | ChecklistScene | SplitScene;

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
