import React from "react";
import { Card } from "./Card.jsx";
import { StatCounter } from "../data/StatCounter.jsx";
import { DeltaPill } from "../data/DeltaPill.jsx";

export function StatCard({
  label,
  value,
  unit,
  prefix,
  caption,
  delta,
  deltaLabel,
  decimals = 0,
  animate = true,
  rail = true,
  className = "",
  ...rest
}) {
  return (
    <Card padding="md" spotlight interactive className={["fi-stat", rail ? "fi-stat--rail" : "", className].filter(Boolean).join(" ")} {...rest}>
      <span className="fi-stat__label">{label}</span>
      <span className="fi-stat__value">
        {prefix && <span className="fi-stat__unit">{prefix}</span>}
        {animate ? <StatCounter value={value} decimals={decimals} /> : <span className="fi-counter">{value}</span>}
        {unit && <span className="fi-stat__unit">{unit}</span>}
      </span>
      {(delta !== undefined || caption) && (
        <span className="fi-stat__foot">
          {delta !== undefined && <DeltaPill value={delta} label={deltaLabel} />}
          {caption && <span className="fi-stat__caption">{caption}</span>}
        </span>
      )}
    </Card>
  );
}
