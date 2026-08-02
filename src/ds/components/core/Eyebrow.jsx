import React from "react";

export function Eyebrow({ children, tone = "default", rule = true, className = "", ...rest }) {
  const cls = ["fi-eyebrow", tone !== "default" ? "fi-eyebrow--" + tone : "", className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {rule && <span className="fi-eyebrow__rule" />}
      {children}
    </span>
  );
}
