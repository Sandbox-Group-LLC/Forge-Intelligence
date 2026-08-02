import * as React from "react";

/**
 * Attributed voice-of-customer card. Initials stand in for photography.
 */
export interface PersonaQuoteProps {
  quote: React.ReactNode;
  name: string;
  role: string;
  /** Overrides the derived initials. */
  initials?: string;
  accent?: "teal" | "blue";
  className?: string;
}
export declare function PersonaQuote(props: PersonaQuoteProps): JSX.Element;
