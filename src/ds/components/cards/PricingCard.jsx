import React from "react";
import { Card } from "./Card.jsx";
import { Icon } from "../brand/Icon.jsx";
import { Button } from "../core/Button.jsx";
import { Badge } from "../core/Badge.jsx";

export function PricingCard({
  tier,
  price,
  cadence = "/mo",
  pitch,
  features = [],
  ctaLabel = "Get started",
  onCta,
  href,
  featured = false,
  ribbon = "Most intelligence",
  note,
  className = "",
  ...rest
}) {
  return (
    <Card
      padding="lg"
      variant={featured ? "gradient" : "default"}
      spotlight
      className={["fi-price", featured ? "fi-price--featured" : "", className].filter(Boolean).join(" ")}
      style={{ height: "100%" }}
      {...rest}
    >
      {featured && ribbon && (
        <span className="fi-price__ribbon"><Badge tone="solid" size="lg">{ribbon}</Badge></span>
      )}
      <span className="fi-price__tier">{tier}</span>
      <span className="fi-price__amount">
        {price}
        <span className="fi-price__cadence">{cadence}</span>
      </span>
      {pitch && <p className="fi-price__pitch">{pitch}</p>}
      <span className="fi-price__divider" aria-hidden="true" />
      <ul className="fi-price__list">
        {features.map((it, i) => (
          <li className="fi-price__item" key={i}>
            <Icon name="check" size={16} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
      <Button variant={featured ? "primary" : "secondary"} block href={href} onClick={onCta} style={{ marginTop: "auto" }}>
        {ctaLabel}
      </Button>
      {note && <span className="fi-stat__caption" style={{ textAlign: "center" }}>{note}</span>}
    </Card>
  );
}
