import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApp } from '../context/AppContext';

// Syncs the Clerk session token into AppContext so API calls can use it
export function ClerkTokenSync() {
  const { getToken, isSignedIn } = useAuth();
  const { updateClerkToken } = useApp();

  useEffect(() => {
    if (!isSignedIn) { updateClerkToken(null); return; }
    const sync = async () => {
      const token = await getToken();
      updateClerkToken(token);
    };
    sync();
    // Refresh token every 50 seconds (Clerk tokens expire in 60s)
    const interval = setInterval(sync, 50000);
    return () => clearInterval(interval);
  }, [isSignedIn]);

  return null;
}
