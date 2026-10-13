import React, { useEffect, useState } from 'react';
import { Button } from '../core/Button.jsx';

/**
 * Cookie/analytics consent banner.
 *
 * Why this exists: the site loads GTM, GA4, Google Ads and Origami visitor
 * tracking. Origami's tag is installed with data-consent="pending", so it sends
 * nothing until it is told a choice — this banner is what tells it.
 *
 * Contract with Origami (vendor rules §3):
 *   - The tag carries data-consent="pending" and stays silent until told.
 *   - On EVERY page load, once the stored choice is known, we must replay it:
 *     origami('consent', 'granted' | 'denied'). Not just at the click.
 *   - 'denied' still sends visits, but without a persistent visitor id.
 *
 * The replay-on-load is the easy thing to get wrong: a visitor who accepted
 * last week arrives with the tag pending again, so without the replay the tag
 * would stay mute forever and tracking would silently never happen.
 */

const STORAGE_KEY = 'fi_consent_v1';
const VALID = new Set(['granted', 'denied']);

/** Reads the stored choice. Returns null when unset or unreadable. */
export function readConsent() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return VALID.has(v) ? v : null;
  } catch {
    // Safari private mode and friends can throw on localStorage access.
    return null;
  }
}

/** Hands a choice to every analytics consumer that needs it. */
function applyConsent(choice) {
  // Origami: company-level visitor tracking.
  try {
    window.origami?.('consent', choice);
  } catch { /* tag not loaded (ad blocker); nothing to tell */ }

  // Google Consent Mode v2, for the GTM/GA4/Ads tags already in index.html.
  // Harmless when gtag isn't present.
  try {
    const granted = choice === 'granted' ? 'granted' : 'denied';
    window.gtag?.('consent', 'update', {
      ad_storage: granted,
      ad_user_data: granted,
      ad_personalization: granted,
      analytics_storage: granted,
    });
  } catch { /* gtag blocked or absent */ }
}

export function ConsentBanner() {
  // `null` = still deciding what to show, so the banner never flashes for
  // someone who already chose.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = readConsent();
    if (stored) {
      // Returning visitor: replay their choice to a freshly-pending tag.
      applyConsent(stored);
      return;
    }
    setVisible(true);
  }, []);

  const choose = (choice) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch { /* unwritable storage: honour the choice for this page at least */ }
    applyConsent(choice);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      className="fi-consent"
      role="region"
      aria-label="Cookie choices"
    >
      <div className="fi-consent__inner">
        <p className="fi-consent__copy">
          We use cookies and analytics to understand how people find Forge Intelligence.{' '}
          <a className="fi-consent__link" href="/privacy">Privacy</a>
        </p>
        <div className="fi-consent__actions">
          <Button variant="tertiary" size="sm" onClick={() => choose('denied')}>
            Decline
          </Button>
          <Button variant="primary" size="sm" onClick={() => choose('granted')}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConsentBanner;
