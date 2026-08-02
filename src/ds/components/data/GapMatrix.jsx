import React from "react";

const LEGEND = [
  { key: "owned", label: "Owned", style: { background: "linear-gradient(180deg,var(--fi-blue-500),var(--fi-blue-600))" } },
  { key: "partial", label: "Partial", style: { background: "var(--fi-blue-a15)", border: "1px solid var(--fi-blue-a25)" } },
  { key: "contested", label: "Contested", style: { border: "1px solid var(--fi-teal-a35)" } },
  { key: "gap", label: "Gap", style: { background: "rgba(245,158,11,.07)", border: "1px dashed rgba(245,158,11,.45)" } },
  { key: "empty", label: "Unclaimed", style: { background: "var(--fi-white-02)", border: "1px solid var(--color-border-hairline)" } },
];

export function GapMatrix({ columns = [], rows = [], legend = true, rowWidth = 180, className = "", ...rest }) {
  return (
    <div className={["fi-gap", className].filter(Boolean).join(" ")} {...rest}>
      <div className="fi-gap__grid" style={{ gridTemplateColumns: rowWidth + "px repeat(" + columns.length + ",minmax(0,1fr))" }}>
        <span className="fi-gap__cornerhead">Topic</span>
        {columns.map((c) => <span className="fi-gap__colhead" key={c}>{c}</span>)}
        {rows.map((r) => (
          <React.Fragment key={r.label}>
            <span className="fi-gap__rowhead" title={r.label}>{r.label}</span>
            {r.cells.map((cell, i) => (
              <span
                key={i}
                className={"fi-gap__cell fi-gap__cell--" + (cell.state || "empty")}
                title={r.label + " · " + columns[i] + " — " + (cell.state || "unclaimed")}
              >
                {cell.value !== undefined ? cell.value : ""}
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
      {legend && (
        <div className="fi-gap__legend">
          {LEGEND.map((l) => (
            <span className="fi-gap__key" key={l.key}>
              <span className="fi-gap__swatch" style={l.style} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
