import React from "react";
import { Icon } from "../brand/Icon.jsx";

export function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  trailingIcon,
  loading = false,
  disabled = false,
  block = false,
  href,
  as,
  className = "",
  ...rest
}) {
  const Tag = as || (href ? "a" : "button");
  const cls = [
    "fi-btn",
    "fi-btn--" + variant,
    "fi-btn--" + size,
    block ? "fi-btn--block" : "",
    className,
  ].filter(Boolean).join(" ");
  const glyph = size === "lg" ? 18 : 16;
  return (
    <Tag
      className={cls}
      href={href}
      disabled={Tag === "button" ? disabled || loading : undefined}
      aria-disabled={Tag !== "button" && (disabled || loading) ? "true" : undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="fi-btn__spinner" />}
      {!loading && icon && <Icon name={icon} size={glyph} className="fi-btn__icon" />}
      {children}
      {trailingIcon && <Icon name={trailingIcon} size={glyph} className="fi-btn__icon fi-btn__icon--trail" />}
    </Tag>
  );
}
