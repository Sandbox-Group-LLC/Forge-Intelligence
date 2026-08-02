import React from "react";

export function Badge({ children, tone = "neutral", size = "sm", dot = false, live = false, className = "", ...rest }) {
  const cls = ["fi-badge", "fi-badge--" + tone, size === "lg" ? "fi-badge--lg" : "", className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {(dot || live) && <span className={"fi-badge__dot" + (live ? " fi-badge__dot--live" : "")} />}
      {children}
    </span>
  );
}
