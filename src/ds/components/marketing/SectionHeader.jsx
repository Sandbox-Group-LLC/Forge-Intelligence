import React from "react";
import { Eyebrow } from "../core/Eyebrow.jsx";

export function SectionHeader({ eyebrow, eyebrowTone = "accent", title, description, action, align = "left", className = "", ...rest }) {
  const head = (
    <div className={["fi-sectionhead", align === "center" ? "fi-sectionhead--center" : "", className].filter(Boolean).join(" ")} {...rest}>
      {eyebrow && <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow>}
      {title && <h2 className="fi-sectionhead__title">{title}</h2>}
      {description && <p className="fi-sectionhead__desc">{description}</p>}
    </div>
  );
  if (!action) return head;
  return <div className="fi-sectionhead__row">{head}{action}</div>;
}
