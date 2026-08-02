import * as React from "react";

/**
 * Plan card. Exactly one card in a pricing row carries featured.
 */
export interface PricingCardProps {
  tier: string;
  /** Formatted string including currency, e.g. "$2,400". */
  price: string;
  cadence?: string;
  pitch?: string;
  features?: string[];
  ctaLabel?: string;
  onCta?: React.MouseEventHandler;
  href?: string;
  /** Gradient border, blue glow, ribbon, primary CTA. */
  featured?: boolean;
  ribbon?: string;
  note?: string;
  className?: string;
}
export declare function PricingCard(props: PricingCardProps): JSX.Element;
