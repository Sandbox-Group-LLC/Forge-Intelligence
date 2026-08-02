import * as React from "react";

/** Scroll-reveal wrapper: 14px rise + fade, once. Inert under prefers-reduced-motion. */
export interface RevealProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  /** Stagger in ms. Use multiples of 60 (--stagger-step). */
  delay?: number;
  as?: keyof JSX.IntrinsicElements;
}
export declare function Reveal(props: RevealProps): JSX.Element;
