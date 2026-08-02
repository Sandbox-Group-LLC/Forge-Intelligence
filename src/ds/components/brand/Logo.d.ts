import * as React from "react";

/** The diamond mark on its own. */
export interface MarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  tone?: "blue" | "teal" | "mono";
}
export declare function Mark(props: MarkProps): JSX.Element;

/**
 * Forge Intelligence lockup: diamond mark + name set in Inter.
 * No drawn wordmark exists in the supplied assets — the name is live type.
 */
export interface LogoProps extends React.HTMLAttributes<HTMLElement> {
  variant?: "full" | "mark" | "wordmark";
  /** Mark height in px; the wordmark scales to 0.75x this. */
  size?: number;
  tone?: "blue" | "teal" | "mono";
  href?: string;
  as?: keyof JSX.IntrinsicElements;
}
export declare function Logo(props: LogoProps): JSX.Element;
