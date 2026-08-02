import React from "react";
import { Badge } from "../core/Badge.jsx";
import { DeltaPill } from "../data/DeltaPill.jsx";
import { useInView } from "../data/useInView.js";

export function BrainTimeline({ entries = [], animate = true, className = "", ...rest }) {
  const [ref, shown] = useInView();
  return (
    <div ref={ref} className={["fi-brain", className].filter(Boolean).join(" ")} {...rest}>
      {entries.map((e, i) => (
        <div className="fi-brain__row" key={e.when + i}>
          <span className="fi-brain__when">{e.when}</span>
          <div className="fi-brain__main">
            <span className="fi-brain__title">
              {e.title}
              {e.tag && <Badge tone={e.tone || "accent"}>{e.tag}</Badge>}
              {e.delta !== undefined && <DeltaPill value={e.delta} unit={e.deltaUnit || ""} />}
            </span>
            {e.note && <span className="fi-brain__note">{e.note}</span>}
            <div className="fi-brain__depth">
              <div
                className="fi-brain__depthfill"
                style={{
                  width: (animate && !shown ? 0 : Math.max(0, Math.min(100, e.depth || 0))) + "%",
                  transitionDelay: i * 90 + "ms",
                }}
              />
            </div>
            {e.facts !== undefined && (
              <span className="fi-brain__facts">{e.facts.toLocaleString()} facts retained</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
