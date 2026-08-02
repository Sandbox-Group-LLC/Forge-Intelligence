import React from "react";
import { Card } from "../cards/Card.jsx";
import { IconTile } from "../brand/Icon.jsx";
import { Badge } from "../core/Badge.jsx";

/**
 * Stages 1 and 2 are the names published on forgeintelligence.ai.
 * Stages 3–8 are working labels derived from the site's description of what the
 * pipeline does — CONFIRM THE REAL STAGE NAMES before shipping. See readme.md > Caveats.
 */
export const PIPELINE_STAGES = [
  { name: "Context Hub", note: "Scrapes your brand, maps the competitive landscape.", icon: "radar" },
  { name: "GEO Strategist", note: "Finds topical territory competitors have not claimed.", icon: "crosshair" },
  { name: "Gap Analysis", note: "Scores undefended positions against demand.", icon: "scan-line" },
  { name: "Audience Model", note: "Reconstructs who is asking, and what they already believe.", icon: "users" },
  { name: "Message Architecture", note: "Resolves the fault lines into a defensible line.", icon: "layers" },
  { name: "Content Engine", note: "Writes from the worldview, not from a prompt.", icon: "pen-tool" },
  { name: "Performance Loop", note: "Reads citation and engagement data back in.", icon: "activity" },
  { name: "Brain Write-back", note: "Commits what it learned. The next run starts smarter.", icon: "brain" },
];

export function Pipeline({
  stages = PIPELINE_STAGES,
  activeIndex = 0,
  completedThrough = -1,
  onSelect,
  showDetail = true,
  pulse = true,
  className = "",
  ...rest
}) {
  const [internal, setInternal] = React.useState(activeIndex);
  React.useEffect(() => setInternal(activeIndex), [activeIndex]);
  const active = stages[internal] || stages[0];
  const pick = (i) => { setInternal(i); onSelect && onSelect(i); };

  return (
    <div className={["fi-pipe", className].filter(Boolean).join(" ")} {...rest}>
      <div className="fi-pipe__rail">
        {pulse && <span className="fi-pipe__pulse" aria-hidden="true" />}
        {stages.map((s, i) => (
          <button
            type="button"
            key={s.name}
            className={[
              "fi-pipe__stage",
              i === internal ? "fi-pipe__stage--active" : "",
              i <= completedThrough ? "fi-pipe__stage--done" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => pick(i)}
            aria-current={i === internal ? "step" : undefined}
          >
            <span className="fi-pipe__line" aria-hidden="true" />
            <span className="fi-pipe__node" aria-hidden="true" />
            <span className="fi-pipe__num">{String(i + 1).padStart(2, "0")}</span>
            <span className="fi-pipe__name">{s.name}</span>
          </button>
        ))}
      </div>

      {showDetail && active && (
        <div className="fi-pipe__detail">
          <Card padding="lg" variant="gradient" spotlight>
            <div style={{ display: "flex", gap: "var(--space-5)", alignItems: "flex-start", flexWrap: "wrap" }}>
              <IconTile name={active.icon || "cpu"} size={48} iconSize={22} tone={internal >= 6 ? "teal" : "accent"} />
              <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Badge tone="accent">Stage {String(internal + 1).padStart(2, "0")}</Badge>
                  <span style={{ fontSize: "var(--text-h3)", fontWeight: 600, letterSpacing: "-.02em", color: "var(--text-primary)" }}>{active.name}</span>
                </div>
                <p style={{ fontSize: "var(--text-base)", lineHeight: "var(--leading-relaxed)", color: "var(--text-body)", maxWidth: "62ch" }}>
                  {active.detail || active.note}
                </p>
                {active.output && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    {active.output.map((o) => <Badge key={o} tone="neutral">{o}</Badge>)}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
