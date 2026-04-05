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
 * - If user has paid or is super admin → render children
 * - If user hasn't paid → show GateModal
 * - On unlock → reload to refresh state
 */
export function RequirePaid({ children, featureName = 'Premium Features' }: RequirePaidProps) {
  const { isPaid, brandProfile, activeBrandId, isSuperAdmin } = useApp();
  const { isLoaded, isSignedIn } = useAuth();
  const [showGate, setShowGate] = useState(false);
  const location = useLocation();

  // Wait for Clerk to load AND for brand data to arrive before making paid decision
  const stillLoading = !isLoaded || (isSignedIn && !activeBrandId);
  
  // User has access if paid OR super admin
  const hasAccess = isPaid || isSuperAdmin;

  useEffect(() => {
    // Show gate modal if no access (after auth is loaded)
    if (!stillLoading && !hasAccess) {
      const timer = setTimeout(() => setShowGate(true), 100);
      return () => clearTimeout(timer);
    }
  }, [hasAccess, stillLoading]);

  // Still loading auth or brand data — show nothing
  if (stillLoading) {
    return null;
  }

  // If has access, render children normally
  if (hasAccess) {
    return <>{children}</>;
  }

  // No access — show gate modal over a redirect to context-hub
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
