import React from "react";

export const ENGINES = ["ChatGPT", "Perplexity", "Gemini", "AI Overviews", "Claude"];

export function EngineChip({ engine, value, unit = "%", state = "absent", className = "", ...rest }) {
  return (
    <span className={["fi-engine", "fi-engine--" + state, className].filter(Boolean).join(" ")} {...rest}>
      <span className="fi-engine__dot" />
      {engine}
      {value !== undefined && <span className="fi-engine__val">{value}{unit}</span>}
    </span>
  );
}

export function EngineChipRow({ items = [], className = "", ...rest }) {
  return (
    <div className={["fi-engine-row", className].filter(Boolean).join(" ")} style={{ display: "flex", flexWrap: "wrap", gap: 8 }} {...rest}>
      {items.map((it) => <EngineChip key={it.engine} {...it} />)}
    </div>
  );
}
