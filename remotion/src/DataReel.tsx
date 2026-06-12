import React from "react";
import {
  AbsoluteFill, Sequence, Audio, Img, staticFile,
  useCurrentFrame, useVideoConfig, interpolate, spring, Easing,
  delayRender, continueRender,
} from "remotion";
import type {
  Brand, Scene, HookScene, TagsScene, OrbitScene,
  PipelineScene, BarsScene, CurveScene, CtaScene, ScreensScene, VideoProps, ThemeId,
  BigStatScene, StatTrioScene, QuoteScene, ComparisonScene, StepsScene,
  GridScene, TimelineScene, StatementScene, LogosScene, ChecklistScene, SplitScene,
} from "./types";

// Forge defaults — any brand.colors key overrides these.
const DEFAULT_COLORS = {
  bg: "#EDF1FF", card: "#FFFFFF", accent: "#3563FF", accent2: "#7a93ff",
  emphasis: "#0F172A", secondary: "#475569", muted: "#94A3B8",
  error: "#DC2626", success: "#0EA572", border: "#E2E8F0",
  onAccent: "#FFFFFF",
};
type Palette = typeof DEFAULT_COLORS;

const DEFAULT_FONT = '-apple-system, "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';

// ── Visual themes ───────────────────────────────────────────────────────────
// Template-level styles. `colors` are applied AFTER the brand's colors, so a
// dark theme's canvas wins over a measured light brand bg (the brand's ACCENT
// still applies — themes don't define accents). `scale` folds into the global
// k unit; `springCfg` drives every entrance; `headlineFont` restyles the big
// type only.
type Theme = {
  colors?: Partial<Palette>;
  headlineFont?: string;
  headlineWeight?: number;
  scale: number;
  springCfg: { damping: number; stiffness?: number; mass?: number };
};
const THEMES: Record<ThemeId, Theme> = {
  // The original light product look.
  clean: { scale: 1, springCfg: { damping: 200 } },
  // Luxury magazine: serif headlines, lighter weight, slower glide.
  editorial: {
    headlineFont: 'Georgia, "Times New Roman", "Palatino Linotype", serif',
    headlineWeight: 600,
    scale: 0.96,
    springCfg: { damping: 200, stiffness: 45, mass: 1.2 },
  },
  // Dark canvas, huge type, high contrast. Theme canvas beats brand bg; brand
  // accent survives.
  bold: {
    colors: {
      bg: "#0B1220", card: "#141D2E", emphasis: "#F8FAFC",
      secondary: "#A6B3C8", muted: "#64748B", border: "#1F2A3D",
    },
    headlineWeight: 800,
    scale: 1.1,
    springCfg: { damping: 200 },
  },
  // Springy, fast, punchy entrances.
  kinetic: { scale: 1.04, springCfg: { damping: 14, stiffness: 160, mass: 0.7 } },
};

// Sizes below are authored against a landscape design width. `k` rescales every
// dimension to the actual canvas so the SAME layout works at 1920x1080 and
// 1080x1920 — portrait just gets a tighter unit and the flex rows wrap.
type Layout = { k: number; portrait: boolean };
const Ctx = React.createContext<{ C: Palette; font: string; brand: Brand; L: Layout; T: Theme }>({
  C: DEFAULT_COLORS, font: DEFAULT_FONT, brand: { name: "Forge Intelligence" },
  L: { k: 1, portrait: false }, T: THEMES.clean,
});

const useL = () => React.useContext(Ctx).L;
const useT = () => React.useContext(Ctx).T;

// Headline style fragment shared by every big-type element.
const useHeadline = () => {
  const T = useT();
  return { fontFamily: T.headlineFont, fontWeight: T.headlineWeight ?? 800 } as const;
};

// audio: full URL (S3) used as-is, bare filename resolved locally.
const audioSrc = (a?: string) =>
  !a ? null : /^https?:\/\//.test(a) ? a : staticFile(`audio/${a}`);

// Generic asset (screenshot / logo / music): full URL used as-is, anything
// else resolved from public/ via staticFile — same convention as audio.
const assetSrc = (a: string) => (/^https?:\/\//.test(a) ? a : staticFile(a));

const Diamond: React.FC<{ size?: number }> = ({ size = 40 }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  return (
    <svg width={size * k} height={size * k} viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth={1.6} strokeLinejoin="round">
      <polygon points="12 2 22 12 12 22 2 12" />
    </svg>
  );
};

// Brand mark: the brand's real logo if we measured one; the Forge diamond only
// for Forge itself; nothing for a third-party brand without a logo (better than
// stamping Forge's diamond on someone else's reel).
const BrandMark: React.FC<{ size?: number }> = ({ size = 36 }) => {
  const { brand, L } = React.useContext(Ctx);
  const { k } = L;
  if (brand.logo) return <Img src={assetSrc(brand.logo)} style={{ height: size * k, width: "auto", objectFit: "contain" }} />;
  if (/forge/i.test(brand.name)) return <Diamond size={size} />;
  return null;
};

const useRise = (delay = 0, dist = 50) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { k } = useL();
  const T = useT();
  const s = spring({ frame: frame - delay, fps, config: T.springCfg });
  return { opacity: Math.min(1, s), transform: `translateY(${interpolate(s, [0, 1], [dist * k, 0])}px)` };
};

// Scale scene content DOWN to fit the safe area, so a long headline or a deck
// scene with many items can never render out of frame. Measures natural size
// (scrollWidth/Height, unaffected by the transform) once and shrinks if needed;
// delayRender holds the frame until the measurement lands on Lambda.
const Fit: React.FC<{ children: React.ReactNode; pad: number }> = ({ children, pad }) => {
  const { width, height } = useVideoConfig();
  const ref = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  const [handle] = React.useState(() => delayRender("fit-measure"));
  React.useEffect(() => {
    const el = ref.current;
    if (el) {
      const s = Math.min(1, (width - pad * 2) / el.scrollWidth, (height - pad * 2) / el.scrollHeight);
      if (s > 0 && s < 0.999) setScale(s);
    }
    continueRender(handle);
  }, [handle, width, height, pad]);
  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: "center center", display: "flex", justifyContent: "center", alignItems: "center" }}>
      <div ref={ref}>{children}</div>
    </div>
  );
};

const Stage: React.FC<{ children: React.ReactNode; audio?: string }> = ({ children, audio }) => {
  const { C, font, brand, L } = React.useContext(Ctx);
  const { k } = L;
  const src = audioSrc(audio);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: font, justifyContent: "center", alignItems: "center", padding: 120 * k, overflow: "hidden" }}>
      {src && <Audio src={src} />}
      <div style={{ position: "absolute", top: 64 * k, left: 90 * k, display: "flex", alignItems: "center", gap: 14 * k }}>
        {brand.wordmark ? (
          <Img src={assetSrc(brand.wordmark)} style={{ height: 44 * k, width: "auto", objectFit: "contain" }} />
        ) : (
          <><BrandMark size={36} /><span style={{ fontWeight: 700, fontSize: 32 * k, color: C.emphasis }}>{brand.name}</span></>
        )}
      </div>
      <Fit pad={120 * k}>{children}</Fit>
    </AbsoluteFill>
  );
};

const HookView: React.FC<{ s: HookScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  const hl = useHeadline();
  const a = useRise(0), b = useRise(14);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 * k }}>
        {s.eyebrow && (
          <div style={{ ...a, fontSize: 28 * k, letterSpacing: 6 * k, color: C.accent, fontWeight: 700, marginBottom: 28 * k }}>{s.eyebrow}</div>
        )}
        <div style={{ ...a, ...hl, fontSize: 110 * k, color: C.emphasis, lineHeight: 1.05 }}>
          {s.headline}
          {s.emphasis && <><br /><span style={{ color: C.accent }}>{s.emphasis}</span></>}
        </div>
        {s.sub && <div style={{ ...b, fontSize: 46 * k, color: C.secondary, marginTop: 40 * k, fontWeight: 500 }}>{s.sub}</div>}
      </div>
    </Stage>
  );
};

const TagsView: React.FC<{ s: TagsScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 * k }}>
        <div style={{ ...head, ...hl, fontSize: 80 * k, color: C.emphasis, lineHeight: 1.1 }}>{s.headline}</div>
        <div style={{ display: "flex", gap: 22 * k, justifyContent: "center", flexWrap: "wrap", marginTop: 56 * k }}>
          {s.tags.map((t, i) => {
            const r = useRise(30 + i * 14);
            return (
              <span key={t} style={{ ...r, fontSize: 44 * k, fontWeight: 700, color: C.secondary, background: C.card, border: `2px solid ${C.border}`, borderRadius: 16 * k, padding: `${20 * k}px ${40 * k}px` }}>{t}</span>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const OrbitView: React.FC<{ s: OrbitScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k, portrait } = useL();
  const T = useT();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const core = spring({ frame, fps, config: T.springCfg });
  const sub = useRise(70);
  const radius = (portrait ? 300 : 330) * k; // tighter ring in portrait so chips don't clip
  return (
    <Stage audio={s.audio}>
      <div style={{ position: "relative", width: 900 * k, height: 620 * k, display: "flex", justifyContent: "center", alignItems: "center" }}>
        <div style={{
          transform: `scale(${core})`, width: 280 * k, height: 280 * k, borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, ${C.accent2}, ${C.accent})`,
          boxShadow: `0 0 ${90 * k}px rgba(53,99,255,0.45)`, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ color: C.onAccent, fontSize: 38 * k, fontWeight: 800, textAlign: "center", lineHeight: 1.1 }}>
            {s.centerLabel.split("\n").map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}
          </span>
        </div>
        {s.facets.map((f, i) => {
          const ang = (i / s.facets.length) * Math.PI * 2 - Math.PI / 2;
          const appear = spring({ frame: frame - 24 - i * 10, fps, config: T.springCfg });
          const x = Math.cos(ang) * radius, y = Math.sin(ang) * radius * 0.62;
          return (
            <div key={f} style={{
              position: "absolute", left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)`,
              transform: `translate(-50%,-50%) scale(${appear})`, opacity: Math.min(1, appear),
              background: C.card, border: `2px solid ${C.accent}`, color: C.accent, fontWeight: 700,
              fontSize: 34 * k, padding: `${16 * k}px ${30 * k}px`, borderRadius: 999, whiteSpace: "nowrap",
              boxShadow: `0 ${8 * k}px ${30 * k}px rgba(53,99,255,0.15)`,
            }}>{f}</div>
          );
        })}
      </div>
      {s.caption && (
        <div style={{ ...sub, fontSize: 50 * k, color: C.emphasis, fontWeight: 700, marginTop: 30 * k, textAlign: "center", maxWidth: 1400 * k }}>
          {s.caption} {s.captionEmphasis && <span style={{ color: C.accent }}>{s.captionEmphasis}</span>}
        </div>
      )}
    </Stage>
  );
};

const PipelineView: React.FC<{ s: PipelineScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k, portrait } = useL();
  const T = useT();
  const hl = useHeadline();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: (portrait ? 920 : 1700) * k, textAlign: "center" }}>
        <div style={{ ...head, ...hl, fontSize: 70 * k, color: C.emphasis, marginBottom: 70 * k }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: portrait ? 14 * k : 0, rowGap: 18 * k }}>
          {s.stages.map((st, i) => {
            const lit = spring({ frame: frame - 20 - i * 16, fps, config: T.springCfg });
            const isLast = s.highlightLast !== false && i === s.stages.length - 1;
            return (
              <React.Fragment key={st}>
                <div style={{
                  transform: `scale(${interpolate(lit, [0, 1], [0.7, 1])})`, opacity: Math.min(1, lit),
                  borderRadius: 999, flexShrink: 0, whiteSpace: "nowrap",
                  background: isLast ? C.accent : C.card, color: isLast ? C.onAccent : C.emphasis,
                  border: `2px solid ${isLast ? C.accent : `${C.accent}66`}`,
                  fontSize: 30 * k, fontWeight: 700, padding: `${20 * k}px ${40 * k}px`,
                  boxShadow: isLast
                    ? `0 0 ${56 * k}px ${C.accent}73, 0 0 ${16 * k}px ${C.accent}59`
                    : `0 0 ${28 * k}px ${C.accent}33`,
                }}>{st}</div>
                {!portrait && i < s.stages.length - 1 && (
                  <div style={{ width: 44 * k, height: 4 * k, background: C.border, flexShrink: 0, opacity: Math.min(1, lit), borderRadius: 2 }} />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const BarRow: React.FC<{ label: string; pct: number; delay: number }> = ({ label, pct, delay }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  const frame = useCurrentFrame();
  const w = interpolate(frame - delay, [0, 30], [0, pct], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const zero = pct === 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 28 * k, marginBottom: 22 * k }}>
      <span style={{ width: 380 * k, fontSize: 38 * k, fontWeight: 600, color: C.emphasis }}>{label}</span>
      <div style={{ flex: 1, height: 30 * k, background: C.border, borderRadius: 15 * k, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(w, zero ? 1.2 : w)}%`, height: "100%", background: zero ? C.muted : C.accent, borderRadius: 15 * k }} />
      </div>
      <span style={{ width: 100 * k, textAlign: "right", fontSize: 38 * k, fontWeight: 700, color: zero ? C.muted : C.emphasis }}>{Math.round(w)}%</span>
    </div>
  );
};

const BarsView: React.FC<{ s: BarsScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1500 * k }}>
        <div style={{ ...head, ...hl, fontSize: 64 * k, color: C.emphasis, marginBottom: 48 * k, textAlign: "center" }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        {s.bars.map((b, i) => <BarRow key={b.label} label={b.label} pct={b.pct} delay={40 + i * 12} />)}
        {s.footnoteChips && s.footnoteChips.length > 0 && (
          <div style={{ marginTop: 40 * k }}>
            {s.footnoteLabel && <div style={{ fontSize: 28 * k, letterSpacing: 3 * k, color: C.muted, fontWeight: 700, marginBottom: 18 * k }}>{s.footnoteLabel}</div>}
            <div style={{ display: "flex", gap: 16 * k, flexWrap: "wrap" }}>
              {s.footnoteChips.map((c, i) => {
                const r = useRise(150 + i * 12, 26);
                return <span key={c} style={{ ...r, fontSize: 36 * k, fontWeight: 600, color: C.accent, background: "rgba(53,99,255,0.10)", border: "2px solid rgba(53,99,255,0.28)", borderRadius: 999, padding: `${14 * k}px ${30 * k}px` }}>{c}</span>;
              })}
            </div>
          </div>
        )}
      </div>
    </Stage>
  );
};

const CurveView: React.FC<{ s: CurveScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k } = useL();
  const hl = useHeadline();
  const frame = useCurrentFrame();
  const head = useRise(0);
  const progress = interpolate(frame, [20, 130], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const W = 1300 * k, H = 360 * k;
  const curveX = 60 * k + progress * (W - 120 * k);
  const curveY = (H - 40 * k) - progress * progress * (H - 90 * k);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: W, textAlign: "center" }}>
        <div style={{ ...head, ...hl, fontSize: 76 * k, color: C.emphasis, marginBottom: 50 * k }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        <svg width={W} height={H} style={{ overflow: "visible" }}>
          <line x1={60 * k} y1={H - 60 * k} x2={W - 60 * k} y2={H - 60 * k} stroke={C.muted} strokeWidth={5 * k} strokeDasharray={`${10 * k} ${10 * k}`} />
          {s.flatLabel && <text x={W - 60 * k} y={H - 30 * k} fill={C.muted} fontSize={28 * k} textAnchor="end" fontWeight={600}>{s.flatLabel}</text>}
          <path d={`M ${60 * k} ${H - 40 * k} Q ${60 * k + (W - 120 * k) * 0.6} ${H - 40 * k}, ${curveX} ${curveY}`} stroke={C.accent} strokeWidth={8 * k} fill="none" strokeLinecap="round" />
          <circle cx={curveX} cy={curveY} r={14 * k} fill={C.accent} />
        </svg>
      </div>
    </Stage>
  );
};

// Product showcase — REAL screenshots in browser chrome, held static (no Ken
// Burns push — the zoom read as filler and blurred the product). The single
// biggest lever on "this is a brand reel" vs "that's the actual product".
// `shots` are S3 URLs filled by the backend; crossfades if >1. Browser
// chrome + image area use the palette so it sits in any theme (clean/bold/…).
const ScreensView: React.FC<{ s: ScreensScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const { k, portrait } = useL();
  const hl = useHeadline();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = useRise(0);
  const rise = useRise(8, 40);
  const shots = Array.isArray(s.shots) ? s.shots.filter(Boolean) : [];
  const dur = s.durationInFrames || 1;
  const dynamic = s.motion === "dynamic";

  const seg = shots.length > 1 ? dur / shots.length : dur;

  // static mode — crossfade across multiple shots: equal slices, ~14f dissolve.
  const shotOpacity = (i: number) => {
    if (shots.length <= 1) return 1;
    const start = i * seg;
    const fade = 14;
    const inOp = interpolate(frame, [start - fade, start], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const outOp = i < shots.length - 1
      ? interpolate(frame, [start + seg - fade, start + seg], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : 1;
    return Math.min(inOp, outOp);
  };

  // dynamic mode — shot i slides OVER the previous one (spring from the right),
  // and each shot gets one hard punch-in zoom mid-segment: a 6-frame snap to a
  // focal region that then HOLDS. A cut with momentum — explicitly not a drift.
  const slideIn = (i: number) =>
    i <= 0 ? 1 : spring({ frame: frame - i * seg, fps, config: { damping: 17, stiffness: 150, mass: 0.9 } });
  const FOCI = ["68% 24%", "30% 68%", "66% 70%", "32% 26%"]; // alternate focal corners
  const punch = (i: number) => {
    const local = frame - i * seg;
    const at = seg * 0.48;
    return interpolate(local, [at, at + 6], [1, 1.16], {
      extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
    });
  };

  // card entrance — dynamic: 3D fly-in (perspective tilt settling flat);
  // static: the original rise.
  const flyS = spring({ frame: frame - 6, fps, config: { damping: 15, stiffness: 130, mass: 0.9 } });
  const fly = dynamic
    ? {
        opacity: Math.min(1, flyS),
        transform: `perspective(${1800 * k}px) rotateX(${interpolate(flyS, [0, 1], [24, 0])}deg) translateY(${interpolate(flyS, [0, 1], [160 * k, 0])}px) scale(${interpolate(flyS, [0, 1], [0.9, 1])})`,
        transformOrigin: "center bottom",
      }
    : rise;

  // dynamic gets a wider card (the punch-in earns the real estate) and a
  // brand-accent glow so the product frame reads as the hero of the scene.
  const frameW = (portrait ? 1500 : dynamic ? 1640 : 1480) * k;
  const cardShadow = dynamic
    ? `0 ${24 * k}px ${70 * k}px rgba(0,0,0,0.55), 0 0 ${64 * k}px ${C.accent}59, 0 0 ${18 * k}px ${C.accent}40`
    : `0 ${36 * k}px ${90 * k}px rgba(15,23,42,0.30)`;
  const dot = (c: string) => <span style={{ width: 14 * k, height: 14 * k, borderRadius: 999, background: c, display: "inline-block" }} />;

  return (
    <Stage audio={s.audio}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", maxWidth: 1640 * k }}>
        {s.eyebrow && (
          <div style={{ ...head, fontSize: 26 * k, letterSpacing: 5 * k, color: C.accent, fontWeight: 700, marginBottom: 18 * k, textTransform: "uppercase" }}>{s.eyebrow}</div>
        )}
        <div style={{ ...head, ...hl, fontSize: 60 * k, color: C.emphasis, lineHeight: 1.08, marginBottom: s.stat ? 14 * k : 34 * k }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        {s.stat && (
          <div style={{ ...head, display: "flex", alignItems: "baseline", gap: 12 * k, marginBottom: 34 * k }}>
            <span style={{ ...hl, fontSize: 56 * k, fontWeight: 800, color: C.accent }}>{s.stat.value}</span>
            <span style={{ fontSize: 26 * k, fontWeight: 600, color: C.secondary, letterSpacing: 1 * k }}>{s.stat.label}</span>
          </div>
        )}
        {shots.length > 0 && (
          <div style={{
            ...fly, width: frameW, borderRadius: 20 * k, overflow: "hidden",
            background: C.card, border: `2px solid ${dynamic ? `${C.accent}55` : C.border}`,
            boxShadow: cardShadow,
          }}>
            {/* browser chrome */}
            <div style={{ height: 50 * k, display: "flex", alignItems: "center", gap: 10 * k, padding: `0 ${22 * k}px`, background: C.bg, borderBottom: `2px solid ${C.border}` }}>
              {dot(C.muted)}{dot(C.muted)}{dot(C.muted)}
              {s.urlLabel && (
                <div style={{ marginLeft: 16 * k, flex: 1, maxWidth: 520 * k, height: 30 * k, borderRadius: 999, background: C.card, border: `2px solid ${C.border}`, display: "flex", alignItems: "center", padding: `0 ${18 * k}px`, fontSize: 22 * k, color: C.muted, fontWeight: 600, overflow: "hidden", whiteSpace: "nowrap" }}>{s.urlLabel}</div>
              )}
            </div>
            {/* viewport; default 16:9 cover-crop, or the capture's native ratio
                via shotAspect so nothing clips left/right.
                static = held still + crossfade · dynamic = slide-over + punch-in */}
            <div style={{ position: "relative", width: "100%", aspectRatio: s.shotAspect ?? "16 / 9", overflow: "hidden", background: C.card }}>
              {shots.map((src, i) => {
                if (!dynamic) {
                  return (
                    <Img key={i} src={assetSrc(src)} style={{
                      position: "absolute", inset: 0, width: "100%", height: "100%",
                      objectFit: "cover", objectPosition: "center top",
                      opacity: shotOpacity(i),
                    }} />
                  );
                }
                const sIn = slideIn(i);
                const nIn = i < shots.length - 1 ? slideIn(i + 1) : 0;
                return (
                  <Img key={i} src={assetSrc(src)} style={{
                    position: "absolute", inset: 0, width: "100%", height: "100%",
                    objectFit: "cover", objectPosition: "center top",
                    transform: `translateX(${interpolate(Math.min(1, sIn), [0, 1], [106, 0]) - Math.min(1, nIn) * 16}%) scale(${punch(i)})`,
                    transformOrigin: FOCI[i % FOCI.length],
                    opacity: Math.min(1, sIn) * (1 - Math.min(1, nIn) * 0.5),
                  }} />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Stage>
  );
};

const CtaView: React.FC<{ s: CtaScene }> = ({ s }) => {
  const { C, brand } = React.useContext(Ctx);
  const { k } = useL();
  const hl = useHeadline();
  const a = useRise(0), b = useRise(14), c = useRise(30);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 * k }}>
        {brand.wordmark ? (
          <div style={{ ...b, margin: `0 0 ${40 * k}px`, display: "flex", justifyContent: "center" }}>
            <Img src={assetSrc(brand.wordmark)} style={{ width: 560 * k, height: "auto", objectFit: "contain" }} />
          </div>
        ) : (
          <>
            <div style={a}><BrandMark size={96} /></div>
            <div style={{ ...b, ...hl, fontSize: 96 * k, color: C.emphasis, margin: `${34 * k}px 0 ${26 * k}px` }}>{s.title}</div>
          </>
        )}
        {s.sub && <div style={{ ...b, fontSize: 50 * k, color: C.secondary, fontWeight: 500, marginBottom: 44 * k }}>{s.sub}</div>}
        <div style={{ ...c, fontSize: 46 * k, fontWeight: 700, color: C.onAccent, background: C.accent, borderRadius: 18 * k, padding: `${24 * k}px ${52 * k}px`, display: "inline-block" }}>{s.cta}</div>
      </div>
    </Stage>
  );
};

// ── Expanded deck ───────────────────────────────────────────────────────────
const BigStatView: React.FC<{ s: BigStatScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const a = useRise(0), b = useRise(14);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 * k }}>
        <div style={{ ...a, ...hl, fontSize: 300 * k, lineHeight: 1, color: C.accent }}>{s.stat.value}</div>
        <div style={{ ...b, fontSize: 54 * k, fontWeight: 700, color: C.emphasis, marginTop: 18 * k }}>{s.stat.label}</div>
        {s.sub && <div style={{ ...b, fontSize: 38 * k, color: C.secondary, marginTop: 16 * k, fontWeight: 500 }}>{s.sub}</div>}
      </div>
    </Stage>
  );
};

const StatTrioView: React.FC<{ s: StatTrioScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1640 * k }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 60 * k, color: C.emphasis, marginBottom: 64 * k }}>{s.headline}</div>}
        <div style={{ display: "flex", gap: 64 * k, justifyContent: "center", flexWrap: "wrap" }}>
          {s.stats.map((st, i) => {
            const r = useRise(20 + i * 16);
            return (
              <div key={i} style={{ ...r, textAlign: "center" }}>
                <div style={{ ...hl, fontSize: 130 * k, lineHeight: 1, color: C.accent }}>{st.value}</div>
                <div style={{ fontSize: 30 * k, fontWeight: 600, color: C.secondary, marginTop: 14 * k }}>{st.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const QuoteView: React.FC<{ s: QuoteScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const a = useRise(0), b = useRise(16);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 * k }}>
        <div style={{ ...a, fontSize: 180 * k, lineHeight: 0.6, color: C.accent, fontWeight: 800, fontFamily: 'Georgia, "Times New Roman", serif' }}>&ldquo;</div>
        <div style={{ ...a, ...hl, fontSize: 60 * k, color: C.emphasis, lineHeight: 1.28, fontWeight: 600, marginTop: 12 * k }}>{s.quote}</div>
        {s.attribution && (
          <div style={{ ...b, marginTop: 40 * k }}>
            <div style={{ fontSize: 34 * k, fontWeight: 700, color: C.emphasis }}>{s.attribution.name}</div>
            {s.attribution.role && <div style={{ fontSize: 28 * k, color: C.secondary, marginTop: 6 * k }}>{s.attribution.role}</div>}
          </div>
        )}
      </div>
    </Stage>
  );
};

const ComparisonView: React.FC<{ s: ComparisonScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k, portrait } = useL(); const hl = useHeadline();
  const head = useRise(0);
  const Col: React.FC<{ data: { label: string; items: string[] }; on: boolean; mark: string; delay: number }> = ({ data, on, mark, delay }) => (
    <div style={{ flex: 1, background: C.card, border: `2px solid ${on ? C.accent : C.border}`, borderRadius: 20 * k, padding: `${34 * k}px ${38 * k}px` }}>
      <div style={{ fontSize: 34 * k, fontWeight: 800, color: on ? C.accent : C.muted, marginBottom: 26 * k }}>{data.label}</div>
      {data.items.map((it, i) => {
        const r = useRise(delay + i * 10);
        return (
          <div key={i} style={{ ...r, display: "flex", gap: 14 * k, alignItems: "flex-start", marginBottom: 16 * k, fontSize: 30 * k, color: C.emphasis, fontWeight: 500 }}>
            <span style={{ color: on ? C.accent : C.muted, fontWeight: 800, flexShrink: 0 }}>{mark}</span>{it}
          </div>
        );
      })}
    </div>
  );
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1500 * k }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 64 * k, color: C.emphasis, textAlign: "center", marginBottom: 48 * k }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>}
        <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: 32 * k, alignItems: "stretch" }}>
          <Col data={s.left} on={false} mark="✕" delay={30} />
          <Col data={s.right} on mark="✓" delay={45} />
        </div>
      </div>
    </Stage>
  );
};

const StepsView: React.FC<{ s: StepsScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1300 * k }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 64 * k, color: C.emphasis, textAlign: "center", marginBottom: 54 * k }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>}
        {s.steps.map((st, i) => {
          const r = useRise(20 + i * 16);
          return (
            <div key={i} style={{ ...r, display: "flex", gap: 28 * k, alignItems: "center", marginBottom: 30 * k }}>
              <div style={{ flexShrink: 0, width: 72 * k, height: 72 * k, borderRadius: "50%", background: C.accent, color: C.onAccent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36 * k, fontWeight: 800 }}>{i + 1}</div>
              <div>
                <div style={{ fontSize: 40 * k, fontWeight: 700, color: C.emphasis }}>{st.title}</div>
                {st.detail && <div style={{ fontSize: 30 * k, color: C.secondary, marginTop: 6 * k }}>{st.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Stage>
  );
};

const GridView: React.FC<{ s: GridScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1500 * k }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 60 * k, color: C.emphasis, textAlign: "center", marginBottom: 50 * k }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 28 * k, justifyContent: "center" }}>
          {s.items.map((it, i) => {
            const r = useRise(20 + i * 12);
            return (
              <div key={i} style={{ ...r, flex: "1 1 44%", minWidth: 0, background: C.card, border: `2px solid ${C.border}`, borderRadius: 18 * k, padding: `${30 * k}px ${34 * k}px` }}>
                <div style={{ width: 18 * k, height: 18 * k, borderRadius: 6 * k, background: C.accent, marginBottom: 20 * k }} />
                <div style={{ fontSize: 36 * k, fontWeight: 700, color: C.emphasis }}>{it.title}</div>
                {it.detail && <div style={{ fontSize: 28 * k, color: C.secondary, marginTop: 10 * k, lineHeight: 1.35 }}>{it.detail}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const TimelineView: React.FC<{ s: TimelineScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k, portrait } = useL(); const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: (portrait ? 920 : 1640) * k, textAlign: "center" }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 62 * k, color: C.emphasis, marginBottom: 70 * k }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>}
        <div style={{ display: "flex", flexWrap: portrait ? "wrap" : "nowrap", alignItems: "flex-start", justifyContent: "center", gap: portrait ? 24 * k : 0 }}>
          {s.milestones.map((m, i) => {
            const r = useRise(20 + i * 14); const last = i === s.milestones.length - 1;
            return (
              <React.Fragment key={i}>
                <div style={{ ...r, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, width: portrait ? "auto" : 220 * k }}>
                  <div style={{ width: 28 * k, height: 28 * k, borderRadius: "50%", background: C.accent }} />
                  {m.when && <div style={{ fontSize: 26 * k, fontWeight: 700, color: C.accent, marginTop: 16 * k }}>{m.when}</div>}
                  <div style={{ fontSize: 30 * k, fontWeight: 600, color: C.emphasis, marginTop: 8 * k, maxWidth: 200 * k }}>{m.label}</div>
                </div>
                {!portrait && !last && <div style={{ height: 4 * k, background: C.border, flex: 1, marginTop: 12 * k, minWidth: 40 * k }} />}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const StatementView: React.FC<{ s: StatementScene }> = ({ s }) => {
  const { C, font } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const src = audioSrc(s.audio); const a = useRise(0);
  // Full-bleed accent gradient, white type — a single dramatic beat that breaks
  // the light-canvas rhythm. Ignores theme bg on purpose.
  return (
    <AbsoluteFill style={{ background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`, fontFamily: font, justifyContent: "center", alignItems: "center", padding: 120 * k }}>
      {src && <Audio src={src} />}
      <div style={{ ...a, ...hl, fontSize: 120 * k, color: C.onAccent, textAlign: "center", lineHeight: 1.05, maxWidth: 1500 * k }}>
        {s.headline}{s.emphasis && <><br /><span style={{ opacity: 0.82 }}>{s.emphasis}</span></>}
      </div>
    </AbsoluteFill>
  );
};

const LogosView: React.FC<{ s: LogosScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1640 * k }}>
        <div style={{ ...head, fontSize: 28 * k, letterSpacing: 4 * k, color: C.muted, fontWeight: 700, textTransform: "uppercase", marginBottom: 46 * k }}>{s.label || "Trusted by"}</div>
        <div style={{ display: "flex", gap: 56 * k, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
          {s.names.map((n, i) => {
            const r = useRise(20 + i * 10);
            return <span key={i} style={{ ...r, fontSize: 50 * k, fontWeight: 800, color: C.secondary }}>{n}</span>;
          })}
        </div>
      </div>
    </Stage>
  );
};

const ChecklistView: React.FC<{ s: ChecklistScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k } = useL(); const hl = useHeadline();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ maxWidth: 1200 * k }}>
        {s.headline && <div style={{ ...head, ...hl, fontSize: 64 * k, color: C.emphasis, textAlign: "center", marginBottom: 50 * k }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>}
        {s.items.map((it, i) => {
          const r = useRise(20 + i * 12);
          return (
            <div key={i} style={{ ...r, display: "flex", gap: 22 * k, alignItems: "center", marginBottom: 26 * k, fontSize: 42 * k, color: C.emphasis, fontWeight: 600 }}>
              <span style={{ flexShrink: 0, width: 52 * k, height: 52 * k, borderRadius: "50%", background: C.accent, color: C.onAccent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 * k, fontWeight: 800 }}>✓</span>
              {it}
            </div>
          );
        })}
      </div>
    </Stage>
  );
};

const SplitView: React.FC<{ s: SplitScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx); const { k, portrait } = useL(); const hl = useHeadline();
  const a = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: 60 * k, alignItems: portrait ? "flex-start" : "center", width: 1640 * k }}>
        <div style={{ ...a, ...hl, flex: 1, fontSize: 84 * k, color: C.emphasis, lineHeight: 1.08 }}>{s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}</div>
        <div style={{ flex: 1 }}>
          {s.points.map((p, i) => {
            const r = useRise(20 + i * 14);
            return (
              <div key={i} style={{ ...r, display: "flex", gap: 18 * k, alignItems: "flex-start", marginBottom: 24 * k, fontSize: 36 * k, color: C.secondary, fontWeight: 500 }}>
                <span style={{ color: C.accent, fontWeight: 800, flexShrink: 0 }}>—</span>{p}
              </div>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const renderScene = (s: Scene) => {
  switch (s.type) {
    case "hook": return <HookView s={s} />;
    case "tags": return <TagsView s={s} />;
    case "orbit": return <OrbitView s={s} />;
    case "pipeline": return <PipelineView s={s} />;
    case "bars": return <BarsView s={s} />;
    case "curve": return <CurveView s={s} />;
    case "screens": return <ScreensView s={s} />;
    case "cta": return <CtaView s={s} />;
    case "bigstat": return <BigStatView s={s} />;
    case "stattrio": return <StatTrioView s={s} />;
    case "quote": return <QuoteView s={s} />;
    case "comparison": return <ComparisonView s={s} />;
    case "steps": return <StepsView s={s} />;
    case "grid": return <GridView s={s} />;
    case "timeline": return <TimelineView s={s} />;
    case "statement": return <StatementView s={s} />;
    case "logos": return <LogosView s={s} />;
    case "checklist": return <ChecklistView s={s} />;
    case "split": return <SplitView s={s} />;
  }
};

// Total frames = sum of scene durations. Exposed for calculateMetadata.
export const totalDuration = (scenes: Scene[]) =>
  scenes.reduce((acc, s) => acc + s.durationInFrames, 0);

// Canvas dimensions for an orientation. Exposed for Root's calculateMetadata.
export const dimsFor = (orientation?: string) =>
  orientation === "portrait" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };

// Music ducking. VO clips start at each scene's start and run to roughly the
// scene's end minus a ~0.8s tail (frame math mirrors the backend's
// framesForVoiceover). Duck the bed while VO is speaking, lift it in the
// tails/sceneless gaps, and fade the reel in/out. Pure — exported for tests.
const BED_DUCKED = 0.12;
const BED_OPEN = 0.26;
const VO_TAIL_FRAMES = 24;  // ~0.8s @30fps, matches the backend's VO padding
const EDGE_FADE_FRAMES = 30;
export const musicVolumeAt = (frame: number, scenes: Scene[]) => {
  const total = scenes.reduce((a, s) => a + s.durationInFrames, 0);
  let level = BED_OPEN;
  let offset = 0;
  for (const s of scenes) {
    const end = offset + s.durationInFrames;
    if (frame >= offset && frame < end) {
      const voActive = s.audio ? frame < end - VO_TAIL_FRAMES : false;
      level = voActive ? BED_DUCKED : BED_OPEN;
      break;
    }
    offset = end;
  }
  const fadeIn = Math.min(1, frame / EDGE_FADE_FRAMES);
  const fadeOut = Math.min(1, Math.max(0, (total - frame) / EDGE_FADE_FRAMES));
  return level * fadeIn * fadeOut;
};

export const DataReel: React.FC<VideoProps> = ({ brand, scenes, fontFamily, music, theme }) => {
  const T = THEMES[theme ?? "clean"] ?? THEMES.clean;
  // Precedence: defaults -> brand colors -> theme colors. The theme's canvas
  // (e.g. bold's dark bg) must beat a measured light brand bg, but the brand's
  // ACCENT survives because themes don't define accents.
  const C: Palette = { ...DEFAULT_COLORS, ...(brand.colors || {}), ...(T.colors || {}) };
  const font = fontFamily || DEFAULT_FONT;
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  // Author against ~1740 wide in portrait (so 1080 content fits with margin) and
  // 1920 in landscape; k rescales every dimension to the real canvas width.
  // Theme scale folds into the unit so the whole layout breathes with it.
  const k = (width / (portrait ? 1740 : 1920)) * T.scale;
  const L: Layout = { k, portrait };
  let offset = 0;
  return (
    <Ctx.Provider value={{ C, font, brand, L, T }}>
      <AbsoluteFill style={{ background: C.bg }}>
        {music?.src && (
          <Audio
            src={assetSrc(music.src)}
            loop
            volume={(f) => musicVolumeAt(f, scenes)}
          />
        )}
        {scenes.map((s) => {
          const from = offset;
          offset += s.durationInFrames;
          return (
            <Sequence key={s.id} from={from} durationInFrames={s.durationInFrames}>
              {renderScene(s)}
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </Ctx.Provider>
  );
};
