import React from "react";

/** The diamond mark, taken verbatim from the supplied FI-favicon.svg geometry. */
export function Mark({ size = 22, tone = "blue", className = "", style, ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 856 856"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={("fi-logo__mark " + (tone === "teal" ? "fi-logo__mark--teal " : tone === "mono" ? "fi-logo__mark--mono " : "") + className).trim()}
      style={style}
      {...rest}
    >
      <rect x="180.52" y="180.51" width="494.97" height="494.97" transform="translate(-177.28 428) rotate(-45)" fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="25" />
    </svg>
  );
}

export function Logo({ variant = "full", size = 22, tone = "blue", href = "/", as, className = "", style, ...rest }) {
  const Tag = as || (href ? "a" : "span");
  const wordSize = Math.round(size * 0.75);
  return (
    <Tag href={href} className={("fi-logo " + className).trim()} style={style} aria-label="Forge Intelligence" {...rest}>
      {variant !== "wordmark" && <Mark size={size} tone={tone} />}
      {variant !== "mark" && (
        <span className="fi-logo__word" style={{ fontSize: wordSize }}>
          Forge <span>Intelligence</span>
        </span>
      )}
    </Tag>
  );
}
