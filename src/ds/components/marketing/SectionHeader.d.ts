import * as React from "react";

/** Eyebrow + title + description block that opens every marketing section. */
export interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string;
  eyebrowTone?: "default" | "accent" | "positive";
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned action, e.g. a secondary Button. Forces the row layout. */
  action?: React.ReactNode;
  align?: "left" | "center";
}
export declare function SectionHeader(props: SectionHeaderProps): JSX.Element;
