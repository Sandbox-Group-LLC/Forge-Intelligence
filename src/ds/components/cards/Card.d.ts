import * as React from "react";

/**
 * The Forge surface primitive. Every card in the system is this plus content.
 */
export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  as?: keyof JSX.IntrinsicElements;
  padding?: "sm" | "md" | "lg";
  /** default = hairline; gradient = blue→teal border; quiet = translucent; sunken = recessed panel. */
  variant?: "default" | "gradient" | "quiet" | "sunken";
  /** Lift + border-brighten on hover, focusable. */
  interactive?: boolean;
  /** Interior radial that follows the cursor. */
  spotlight?: boolean;
  /** Blue-tinted elevation glow at rest. Reserve for the focal card in a group. */
  glow?: boolean;
  /** Slowly rotating conic hairline — "this is running right now". Max one per screen. */
  live?: boolean;
}
export declare function Card(props: CardProps): JSX.Element;
