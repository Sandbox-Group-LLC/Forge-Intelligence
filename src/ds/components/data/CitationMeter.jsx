import React from "react";
import { useInView } from "./useInView.js";

export function CitationMeter({
  label,
  value = 0,
  max = 100,
  unit = "%",
  benchmark,
  benchmarkLabel = "Category",
  tone = "default",
  footLeft,
  footRight,
  animate = true,
  className = "",
  ...rest
}) {
  const [ref, shown] = useInView();
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const width = animate ? (shown ? pct : 0) : pct;
  return (
    <div ref={ref} className={["fi-meter", tone !== "default" ? "fi-meter--" + tone : "", className].filter(Boolean).join(" ")} {...rest}>
      {(label || value !== undefined) && (
        <div className="fi-meter__head">
          <span className="fi-meter__label">{label}</span>
          <span className="fi-meter__value">{value}{unit}</span>
        </div>
      )}
      <div
        className="fi-meter__track"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div className="fi-meter__fill" style={{ width: width + "%" }} />
        {benchmark !== undefined && (
          <span className="fi-meter__mark" data-label={benchmarkLabel} style={{ left: (benchmark / max) * 100 + "%" }} />
        )}
      </div>
      {(footLeft || footRight) && (
        <div className="fi-meter__foot"><span>{footLeft}</span><span>{footRight}</span></div>
      )}
    </div>
  );
}
