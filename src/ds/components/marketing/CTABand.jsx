import React from "react";
import { Eyebrow } from "../core/Eyebrow.jsx";

export function CTABand({ eyebrow, title, subtitle, actions, note, className = "", ...rest }) {
  return (
    <div className={["fi-cta", className].filter(Boolean).join(" ")} {...rest}>
      <span className="fi-cta__wash" aria-hidden="true" />
      <div className="fi-cta__inner">
        {eyebrow && <Eyebrow tone="positive">{eyebrow}</Eyebrow>}
        <h2 className="fi-cta__title">{title}</h2>
        {subtitle && <p className="fi-cta__sub">{subtitle}</p>}
        {actions && <div className="fi-cta__actions">{actions}</div>}
        {note && <span className="fi-stat__caption">{note}</span>}
      </div>
    </div>
  );
}
