import * as React from "react";

export interface NavLink { label: string; href: string; }

/**
 * Marketing top bar. Transparent over the hero, then blurs and gains a hairline on scroll.
 * @startingPoint section="Navigation" subtitle="Sticky marketing nav with scroll blur" viewport="1280x120"
 */
export interface NavBarProps extends React.HTMLAttributes<HTMLElement> {
  links?: NavLink[];
  activeHref?: string;
  /** When supplied, link clicks are intercepted and routed through this. */
  onNavigate?: (href: string) => void;
  ctaLabel?: string;
  onCta?: React.MouseEventHandler;
  secondaryLabel?: string;
  onSecondary?: React.MouseEventHandler;
  sticky?: boolean;
}
export declare function NavBar(props: NavBarProps): JSX.Element;
