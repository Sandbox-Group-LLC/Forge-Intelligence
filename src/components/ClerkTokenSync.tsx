import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';

// Keeps Clerk session alive — no-op component, auth state managed by useAuth() hooks
export function ClerkTokenSync() {
  const { isSignedIn } = useAuth();
  useEffect(() => {
    // Token freshness handled by Clerk SDK internally
    // useActiveBrand calls getToken() on each render
  }, [isSignedIn]);
  return null;
}
