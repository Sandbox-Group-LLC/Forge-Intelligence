/** Bottom-anchored cookie/analytics consent bar. Renders nothing once a choice is stored. */
export declare function ConsentBanner(): JSX.Element | null;

/** The stored choice, or null when the visitor hasn't chosen yet. */
export declare function readConsent(): 'granted' | 'denied' | null;

export default ConsentBanner;
