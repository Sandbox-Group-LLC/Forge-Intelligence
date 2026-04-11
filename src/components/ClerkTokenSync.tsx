import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';

// Token freshness is handled by AppContext (55s refresh interval).
// This component is retained as a no-op to avoid breaking imports.
export function ClerkTokenSync() {
  const { isSignedIn } = useAuth();
  useEffect(() => {}, [isSignedIn]);
  return null;
}
