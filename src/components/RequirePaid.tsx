import { ReactNode, useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useAuth } from '@clerk/clerk-react';
import GateModal from './GateModal';

interface RequirePaidProps {
  children: ReactNode;
  featureName?: string;
}

/**
 * Route wrapper that enforces payment gate for premium features.
 * - If user has paid → render children
 * - If user hasn't paid → show GateModal
 * - On unlock → reload to refresh state
 */
export function RequirePaid({ children, featureName = 'Premium Features' }: RequirePaidProps) {
  const { isPaid, brandProfile, activeBrandId } = useApp();
  const { isLoaded, isSignedIn } = useAuth();
  const [showGate, setShowGate] = useState(false);
  const location = useLocation();

  // Wait for Clerk to load AND for brand data to arrive before making paid decision
  const stillLoading = !isLoaded || (isSignedIn && !activeBrandId);

  useEffect(() => {
    // Show gate modal if not paid (after auth is loaded and confirmed not paid)
    if (!stillLoading && !isPaid) {
      const timer = setTimeout(() => setShowGate(true), 100);
      return () => clearTimeout(timer);
    }
  }, [isPaid, stillLoading]);

  // Still loading auth or brand data — show nothing (or a loader)
  if (stillLoading) {
    return null;
  }

  // If paid, render children normally
  if (isPaid) {
    return <>{children}</>;
  }

  // Not paid — show gate modal over a redirect to context-hub
  return (
    <>
      <Navigate to="/app/context-hub" replace state={{ from: location }} />
      {showGate && (
        <GateModal
          featureName={featureName}
          brandProfileId={brandProfile?.id}
          onClose={() => setShowGate(false)}
          onUnlocked={() => window.location.reload()}
        />
      )}
    </>
  );
}
