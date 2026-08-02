import React from "react";
import { Eyebrow } from "../core/Eyebrow.jsx";

export function Hero({ eyebrow, title, subtitle, actions, proof, visual, align = "center", grid = true, beam = true, className = "", ...rest }) {
  return (
    <section className={["fi-hero", align === "left" ? "fi-hero--left" : "", className].filter(Boolean).join(" ")} {...rest}>
      {beam && <span className="fi-hero__beam" aria-hidden="true" />}
      {grid && <span className="fi-hero__grid" aria-hidden="true" />}
      <div className="fi-container">
        <div className="fi-hero__inner">
          {eyebrow && <Eyebrow tone="accent">{eyebrow}</Eyebrow>}
          <h1 className="fi-hero__title">{title}</h1>
          {subtitle && <p className="fi-hero__sub">{subtitle}</p>}
          {actions && <div className="fi-hero__actions">{actions}</div>}
          {proof && <div className="fi-hero__proof">{proof}</div>}
        </div>
        {visual && <div className="fi-hero__visual">{visual}</div>}
      </div>
    </section>
  );
}
