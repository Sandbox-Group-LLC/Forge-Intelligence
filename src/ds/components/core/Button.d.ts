import * as React from "react";

/**
 * Forge action button. Primary carries a gradient sheen and blue glow; secondary is a
 * hairline ghost; tertiary is quiet text; accent is a soft blue fill for in-card actions.
 */
export interface ButtonProps {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "tertiary" | "accent";
  size?: "sm" | "md" | "lg";
  /** Leading Icon name. */
  icon?: string;
  /** Trailing Icon name — nudges 3px right on hover. Use "arrow-right" for forward motion. */
  trailingIcon?: string;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  href?: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  onClick?: React.MouseEventHandler;
  type?: "button" | "submit" | "reset";
}
export declare function Button(props: ButtonProps): JSX.Element;
