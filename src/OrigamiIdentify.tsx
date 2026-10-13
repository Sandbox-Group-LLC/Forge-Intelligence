/**
 * Tells Origami when a browser belongs to someone who already uses the product.
 *
 * Existing users aren't leads, so Origami needs the browser marked — otherwise
 * our own customers and teammates show up in the visitor-company feed.
 *
 * Fires on every app load while signed in (not just at the moment of login),
 * which is what the vendor asks for. Deliberately sends nothing on logout: the
 * browser staying marked is what keeps a logged-out user out of the leads.
 *
 * Passes the Clerk user id — a stable opaque id, never an email. Origami stores
 * only a hash of it.
 */
import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';

declare global {
  interface Window {
    origami?: (...args: unknown[]) => void;
  }
}

export default function OrigamiIdentify() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    // The snippet installs a queueing stub in index.html, so calling before
    // o.js finishes loading is safe.
    window.origami?.('identify', userId);
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
