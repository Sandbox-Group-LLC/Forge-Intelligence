import React from "react";

/**
 * Base surface for the whole card family. Handles the spotlight pointer tracking
 * so every descendant card gets it for free.
 */
export function Card({
  children,
  as: Tag = "div",
  padding = "md",
  variant = "default",
  interactive = false,
  spotlight = false,
  glow = false,
  live = false,
  className = "",
  style,
  ...rest
}) {
  const ref = React.useRef(null);
  const onMove = React.useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--fi-mx", ((e.clientX - r.left) / r.width) * 100 + "%");
    el.style.setProperty("--fi-my", ((e.clientY - r.top) / r.height) * 100 + "%");
  }, []);

  const cls = [
    "fi-card",
    "fi-card--pad-" + padding,
    variant !== "default" ? "fi-card--" + variant : "",
    interactive ? "fi-card--interactive" : "",
    glow ? "fi-card--glow" : "",
    live ? "fi-card--live" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <Tag
      ref={ref}
      className={cls}
      style={style}
      onMouseMove={spotlight ? onMove : undefined}
      tabIndex={interactive && Tag !== "a" && Tag !== "button" ? 0 : undefined}
      {...rest}
    >
      {spotlight && <span className="fi-card__spot" aria-hidden="true" />}
      <div className="fi-card__body">{children}</div>
    </Tag>
  );
}
