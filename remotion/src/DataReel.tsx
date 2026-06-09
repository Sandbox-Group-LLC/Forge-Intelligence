import React from "react";
import {
  AbsoluteFill, Sequence, Audio, staticFile,
  useCurrentFrame, useVideoConfig, interpolate, spring, Easing,
} from "remotion";
import type {
  Brand, Scene, HookScene, TagsScene, OrbitScene,
  PipelineScene, BarsScene, CurveScene, CtaScene, VideoProps,
} from "./types";

// Forge defaults — any brand.colors key overrides these.
const DEFAULT_COLORS = {
  bg: "#EDF1FF", card: "#FFFFFF", accent: "#3563FF", accent2: "#7a93ff",
  emphasis: "#0F172A", secondary: "#475569", muted: "#94A3B8",
  error: "#DC2626", success: "#0EA572", border: "#E2E8F0",
};
type Palette = typeof DEFAULT_COLORS;

const DEFAULT_FONT = '-apple-system, "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';

const Ctx = React.createContext<{ C: Palette; font: string; brand: Brand }>({
  C: DEFAULT_COLORS, font: DEFAULT_FONT, brand: { name: "Forge Intelligence" },
});

// audio: full URL (S3) used as-is, bare filename resolved locally.
const audioSrc = (a?: string) =>
  !a ? null : /^https?:\/\//.test(a) ? a : staticFile(`audio/${a}`);

const Diamond: React.FC<{ size?: number }> = ({ size = 40 }) => {
  const { C } = React.useContext(Ctx);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth={1.6} strokeLinejoin="round">
      <polygon points="12 2 22 12 12 22 2 12" />
    </svg>
  );
};

const useRise = (delay = 0, dist = 50) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [dist, 0])}px)` };
};

const Stage: React.FC<{ children: React.ReactNode; audio?: string }> = ({ children, audio }) => {
  const { C, font, brand } = React.useContext(Ctx);
  const src = audioSrc(audio);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: font, justifyContent: "center", alignItems: "center", padding: 120 }}>
      {src && <Audio src={src} />}
      <div style={{ position: "absolute", top: 64, left: 90, display: "flex", alignItems: "center", gap: 14 }}>
        <Diamond size={36} /><span style={{ fontWeight: 700, fontSize: 32, color: C.emphasis }}>{brand.name}</span>
      </div>
      {children}
    </AbsoluteFill>
  );
};

// ── scene renderers ──

const HookView: React.FC<{ s: HookScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const a = useRise(0), b = useRise(14), c = useRise(24);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 }}>
        {s.eyebrow && (
          <div style={{ ...a, fontSize: 28, letterSpacing: 6, color: C.accent, fontWeight: 700, marginBottom: 28 }}>{s.eyebrow}</div>
        )}
        <div style={{ ...a, fontSize: 110, fontWeight: 800, color: C.emphasis, lineHeight: 1.05 }}>
          {s.headline}
          {s.emphasis && <><br /><span style={{ color: C.error }}>{s.emphasis}</span></>}
        </div>
        {s.sub && <div style={{ ...b, fontSize: 46, color: C.secondary, marginTop: 40, fontWeight: 500 }}>{s.sub}</div>}
        <div style={c} />
      </div>
    </Stage>
  );
};

const TagsView: React.FC<{ s: TagsScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center", maxWidth: 1500 }}>
        <div style={{ ...head, fontSize: 80, fontWeight: 800, color: C.emphasis, lineHeight: 1.1 }}>{s.headline}</div>
        <div style={{ display: "flex", gap: 22, justifyContent: "center", flexWrap: "wrap", marginTop: 56 }}>
          {s.tags.map((t, i) => {
            const r = useRise(30 + i * 14);
            return (
              <span key={t} style={{ ...r, fontSize: 44, fontWeight: 700, color: C.secondary, background: C.card, border: `2px solid ${C.border}`, borderRadius: 16, padding: "20px 40px" }}>{t}</span>
            );
          })}
        </div>
      </div>
    </Stage>
  );
};

const OrbitView: React.FC<{ s: OrbitScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const core = spring({ frame, fps, config: { damping: 200 } });
  const sub = useRise(70);
  return (
    <Stage audio={s.audio}>
      <div style={{ position: "relative", width: 900, height: 620, display: "flex", justifyContent: "center", alignItems: "center" }}>
        <div style={{
          transform: `scale(${core})`, width: 280, height: 280, borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, ${C.accent2}, ${C.accent})`,
          boxShadow: `0 0 90px rgba(53,99,255,0.45)`, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ color: "#fff", fontSize: 38, fontWeight: 800, textAlign: "center", lineHeight: 1.1 }}>
            {s.centerLabel.split("\n").map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}
          </span>
        </div>
        {s.facets.map((f, i) => {
          const ang = (i / s.facets.length) * Math.PI * 2 - Math.PI / 2;
          const r = 330;
          const appear = spring({ frame: frame - 24 - i * 10, fps, config: { damping: 200 } });
          const x = Math.cos(ang) * r, y = Math.sin(ang) * r * 0.62;
          return (
            <div key={f} style={{
              position: "absolute", left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)`,
              transform: `translate(-50%,-50%) scale(${appear})`, opacity: appear,
              background: C.card, border: `2px solid ${C.accent}`, color: C.accent, fontWeight: 700,
              fontSize: 34, padding: "16px 30px", borderRadius: 999, whiteSpace: "nowrap",
              boxShadow: "0 8px 30px rgba(53,99,255,0.15)",
            }}>{f}</div>
          );
        })}
      </div>
      {s.caption && (
        <div style={{ ...sub, fontSize: 50, color: C.emphasis, fontWeight: 700, marginTop: 30, textAlign: "center" }}>
          {s.caption} {s.captionEmphasis && <span style={{ color: C.accent }}>{s.captionEmphasis}</span>}
        </div>
      )}
    </Stage>
  );
};

const PipelineView: React.FC<{ s: PipelineScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1640, textAlign: "center" }}>
        <div style={{ ...head, fontSize: 70, fontWeight: 800, color: C.emphasis, marginBottom: 70 }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 0 }}>
          {s.stages.map((st, i) => {
            const lit = spring({ frame: frame - 20 - i * 16, fps, config: { damping: 200 } });
            const isLast = s.highlightLast !== false && i === s.stages.length - 1;
            return (
              <React.Fragment key={st}>
                <div style={{
                  transform: `scale(${interpolate(lit, [0, 1], [0.7, 1])})`, opacity: lit,
                  width: 150, height: 150, borderRadius: 24, flexShrink: 0,
                  background: isLast ? C.accent : C.card, color: isLast ? "#fff" : C.emphasis,
                  border: `2px solid ${isLast ? C.accent : C.border}`,
                  display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
                  fontSize: 26, fontWeight: 700, padding: 8,
                  boxShadow: isLast ? "0 0 50px rgba(53,99,255,0.4)" : "0 6px 20px rgba(15,23,42,0.06)",
                }}>{st}</div>
                {i < s.stages.length - 1 && (
                  <div style={{ width: 44, height: 4, background: C.border, flexShrink: 0, opacity: lit, borderRadius: 2 }} />
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
  const frame = useCurrentFrame();
  const w = interpolate(frame - delay, [0, 30], [0, pct], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const zero = pct === 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 28, marginBottom: 22 }}>
      <span style={{ width: 380, fontSize: 38, fontWeight: 600, color: C.emphasis }}>{label}</span>
      <div style={{ flex: 1, height: 30, background: "#dfe5f5", borderRadius: 15, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(w, zero ? 1.2 : w)}%`, height: "100%", background: zero ? C.error : C.accent, borderRadius: 15 }} />
      </div>
      <span style={{ width: 100, textAlign: "right", fontSize: 38, fontWeight: 700, color: zero ? C.error : C.emphasis }}>{Math.round(w)}%</span>
    </div>
  );
};

const BarsView: React.FC<{ s: BarsScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const head = useRise(0);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: 1500 }}>
        <div style={{ ...head, fontSize: 64, fontWeight: 800, color: C.emphasis, marginBottom: 48, textAlign: "center" }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        {s.bars.map((b, i) => <BarRow key={b.label} label={b.label} pct={b.pct} delay={40 + i * 12} />)}
        {s.footnoteChips && s.footnoteChips.length > 0 && (
          <div style={{ marginTop: 40 }}>
            {s.footnoteLabel && <div style={{ fontSize: 28, letterSpacing: 3, color: C.muted, fontWeight: 700, marginBottom: 18 }}>{s.footnoteLabel}</div>}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {s.footnoteChips.map((c, i) => {
                const r = useRise(150 + i * 12, 26);
                return <span key={c} style={{ ...r, fontSize: 36, fontWeight: 600, color: C.accent, background: "rgba(53,99,255,0.10)", border: "2px solid rgba(53,99,255,0.28)", borderRadius: 999, padding: "14px 30px" }}>{c}</span>;
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
  const frame = useCurrentFrame();
  const head = useRise(0);
  const progress = interpolate(frame, [20, 130], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const W = 1300, H = 360;
  const curveX = 60 + progress * (W - 120);
  const curveY = (H - 40) - progress * progress * (H - 90);
  return (
    <Stage audio={s.audio}>
      <div style={{ width: W, textAlign: "center" }}>
        <div style={{ ...head, fontSize: 76, fontWeight: 800, color: C.emphasis, marginBottom: 50 }}>
          {s.headline} {s.headlineEmphasis && <span style={{ color: C.accent }}>{s.headlineEmphasis}</span>}
        </div>
        <svg width={W} height={H} style={{ overflow: "visible" }}>
          <line x1={60} y1={H - 60} x2={W - 60} y2={H - 60} stroke={C.muted} strokeWidth={5} strokeDasharray="10 10" />
          {s.flatLabel && <text x={W - 60} y={H - 30} fill={C.muted} fontSize={28} textAnchor="end" fontWeight={600}>{s.flatLabel}</text>}
          <path d={`M 60 ${H - 40} Q ${60 + (W - 120) * 0.6} ${H - 40}, ${curveX} ${curveY}`} stroke={C.accent} strokeWidth={8} fill="none" strokeLinecap="round" />
          <circle cx={curveX} cy={curveY} r={14} fill={C.accent} />
        </svg>
      </div>
    </Stage>
  );
};

const CtaView: React.FC<{ s: CtaScene }> = ({ s }) => {
  const { C } = React.useContext(Ctx);
  const a = useRise(0), b = useRise(14), c = useRise(30);
  return (
    <Stage audio={s.audio}>
      <div style={{ textAlign: "center" }}>
        <div style={a}><Diamond size={96} /></div>
        <div style={{ ...b, fontSize: 96, fontWeight: 800, color: C.emphasis, margin: "34px 0 26px" }}>{s.title}</div>
        {s.sub && <div style={{ ...b, fontSize: 50, color: C.secondary, fontWeight: 500, marginBottom: 44 }}>{s.sub}</div>}
        <div style={{ ...c, fontSize: 46, fontWeight: 700, color: "#fff", background: C.accent, borderRadius: 18, padding: "24px 52px", display: "inline-block" }}>{s.cta}</div>
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
    case "cta": return <CtaView s={s} />;
  }
};

// Total frames = sum of scene durations. Exposed for calculateMetadata.
export const totalDuration = (scenes: Scene[]) =>
  scenes.reduce((acc, s) => acc + s.durationInFrames, 0);

export const DataReel: React.FC<VideoProps> = ({ brand, scenes, fontFamily }) => {
  const C: Palette = { ...DEFAULT_COLORS, ...(brand.colors || {}) };
  const font = fontFamily || DEFAULT_FONT;
  let offset = 0;
  return (
    <Ctx.Provider value={{ C, font, brand }}>
      <AbsoluteFill style={{ background: C.bg }}>
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
