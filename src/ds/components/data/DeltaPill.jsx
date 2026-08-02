import React from "react";
import { Icon } from "../brand/Icon.jsx";

export function DeltaPill({ value = 0, label, unit = "", className = "", ...rest }) {
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const cls = ["fi-delta", dir !== "flat" ? "fi-delta--" + dir : "", className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {dir !== "flat" && <Icon name={dir === "up" ? "trending-up" : "trending-down"} size={12} strokeWidth={2.25} />}
      {value > 0 ? "+" : ""}{value}{unit}
      {label && <span style={{ opacity: 0.7, fontWeight: 500 }}>{label}</span>}
    </span>
  );
}
