import React from "react";
import { Icon } from "../brand/Icon.jsx";

export function IconButton({ icon, label, size = "md", variant = "default", className = "", ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={["fi-iconbtn", "fi-iconbtn--" + size, variant === "ghost" ? "fi-iconbtn--ghost" : "", className].filter(Boolean).join(" ")}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 18} />
    </button>
  );
}
