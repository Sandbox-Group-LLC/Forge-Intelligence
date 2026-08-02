import * as React from "react";

export interface FooterColumn { title: string; links: { label: string; href: string }[]; }

/**
 * Site footer: lockup + blurb, three link columns, hairline rule, legal bar in --text-footer.
 * @startingPoint section="Navigation" subtitle="Four-column site footer" viewport="1280x420"
 */
export interface FooterProps extends React.HTMLAttributes<HTMLElement> {
  blurb?: string;
  columns?: FooterColumn[];
  legal?: { label: string; href: string }[];
  copyright?: string;
}
export declare function Footer(props: FooterProps): JSX.Element;
