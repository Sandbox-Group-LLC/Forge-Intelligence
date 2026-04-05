import { ReactNode, useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import GateModal from './GateModal';

interface RequirePaidProps {
  children: ReactNode;
  featureName?: string;
}

/**
 * Route wrapper that enforces payment gate.
 * 
 * SIMPLE RULES:
 * - isAuthLoading → show nothing (wait)
 * - hasAccess (super admin OR paid) → render children
 * - no access → show gate modal
 */
export function RequirePaid({ children, featureName = 'Premium Features' }: RequirePaidProps) {
  const { isAuthLoading, hasAccess, brandProfile } = useApp();
  const location = useLocation();
  const [showGate, setShowGate] = useState(false);

  useEffect(() => {
    if (!isAuthLoading && !hasAccess) {
      setShowGate(true);
    }
  }, [isAuthLoading, hasAccess]);

  // Still loading - show nothing
  if (isAuthLoading) {
    return null;
  }

  // Has access - render children
  if (hasAccess) {
    return <>{children}</>;
  }

  // No access - gate modal
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
