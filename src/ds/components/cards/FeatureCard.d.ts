import * as React from "react";

/**
 * Capability card: icon tile, title, one paragraph, optional forward link.
 */
export interface FeatureCardProps {
  /** Icon name for the tile. */
  icon?: string;
  iconTone?: "accent" | "teal" | "quiet";
  title: string;
  children?: React.ReactNode;
  /** Renders the arrow link row and makes the whole card the anchor. */
  linkLabel?: string;
  href?: string;
  badge?: React.ReactNode;
  className?: string;
}
export declare function FeatureCard(props: FeatureCardProps): JSX.Element;
