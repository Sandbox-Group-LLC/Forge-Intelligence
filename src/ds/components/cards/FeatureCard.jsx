import React from "react";
import { Card } from "./Card.jsx";
import { Icon, IconTile } from "../brand/Icon.jsx";

export function FeatureCard({ icon, iconTone = "accent", title, children, linkLabel, href, badge, className = "", ...rest }) {
  const interactive = Boolean(href);
  return (
    <Card
      as={href ? "a" : "div"}
      href={href}
      padding="lg"
      variant="gradient"
      spotlight
      interactive={interactive}
      className={["fi-feature", className].filter(Boolean).join(" ")}
      style={{ textDecoration: "none", height: "100%" }}
      {...rest}
    >
      <span className="fi-feature__head">
        {icon && <IconTile name={icon} tone={iconTone} size={40} />}
        <span className="fi-feature__title">{title}</span>
        {badge}
      </span>
      <p className="fi-feature__body">{children}</p>
      {linkLabel && (
        <span className="fi-feature__link">
          {linkLabel}
          <Icon name="arrow-right" size={15} />
        </span>
      )}
    </Card>
  );
}
