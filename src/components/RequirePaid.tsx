import { ReactNode, useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
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
  const { isPaid, brandProfile } = useApp();
  const [showGate, setShowGate] = useState(false);
  const location = useLocation();

  useEffect(() => {
    // Show gate modal if not paid (after a brief delay to let state settle)
    if (!isPaid) {
      const timer = setTimeout(() => setShowGate(true), 100);
      return () => clearTimeout(timer);
    }
  }, [isPaid]);

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
