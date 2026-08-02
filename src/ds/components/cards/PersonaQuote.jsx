import React from "react";
import { Card } from "./Card.jsx";

export function PersonaQuote({ quote, name, role, initials, accent = "teal", className = "", ...rest }) {
  const auto = initials || (name || "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <Card padding="lg" spotlight className={["fi-quote", className].filter(Boolean).join(" ")} style={{ height: "100%" }} {...rest}>
      <span className="fi-quote__rule" aria-hidden="true" style={accent === "blue" ? { background: "linear-gradient(90deg,var(--fi-blue-500),var(--fi-teal-400))" } : undefined} />
      <blockquote className="fi-quote__text" style={{ margin: 0 }}>{quote}</blockquote>
      <span className="fi-quote__who">
        <span className="fi-quote__avatar">{auto}</span>
        <span>
          <span className="fi-quote__name" style={{ display: "block" }}>{name}</span>
          <span className="fi-quote__role">{role}</span>
        </span>
      </span>
    </Card>
  );
}
