import * as React from "react";

/** Line icon from the Forge glyph set (Lucide, 1.75 stroke). */
export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "name"> {
  /** Glyph name, e.g. "radar" | "brain" | "arrow-right". See ICON_NAMES. */
  name: string;
  /** Pixel box. 16 for inline text, 20 default, 24 for tiles. */
  size?: number;
  /** Stroke weight. Forge default is 1.75. */
  strokeWidth?: number;
  /** Accessible label. Omit for decorative icons. */
  title?: string;
}
export declare function Icon(props: IconProps): JSX.Element | null;
export declare const ICON_NAMES: string[];

/** Square tinted tile holding an icon — the standard feature-card affordance. */
export interface IconTileProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: string;
  size?: number;
  iconSize?: number;
  tone?: "accent" | "teal" | "quiet";
}
export declare function IconTile(props: IconTileProps): JSX.Element;
