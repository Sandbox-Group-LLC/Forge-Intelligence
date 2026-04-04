import React, { StrictMode } from 'react';
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Landing from './Landing';
import ContextAgentPage from './pages/ContextAgentPage';
import GeoStrategistPage from './pages/GeoStrategistPage';
import AuthenticityEnricherPage from './pages/AuthenticityEnricherPage';
import ContentGeneratorPage from './pages/ContentGeneratorPage';
import CampaignGeneratorPage from './pages/CampaignGeneratorPage';
import ComplianceGatePage from './pages/ComplianceGatePage';
import IntegrationsPage from './pages/IntegrationsPage';
import PublishingQueuePage from './pages/PublishingQueuePage';
import PublicArticlePage from './pages/PublicArticlePage';
import PerformanceDashboardPage from './pages/PerformanceDashboardPage';
import BrandSettingsPage from './pages/BrandSettingsPage';
import ContentLibraryPage from './pages/ContentLibraryPage';
import ContentImportPage from './pages/ContentImportPage';
import AdminPage from './pages/AdminPage';
import TopicQueuePage from './pages/TopicQueuePage';
import ReviewPage from './pages/ReviewPage';
import './index.css';


// God mode bootstrap — runs before any route renders
// Must happen here before AppContext initializes
(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('god') === 'ForgeCanvas') {
    localStorage.setItem('forge_god_mode', 'true');
    window.history.replaceState({}, '', '/app/context-hub');
  } else if (params.has('ungod')) {
    localStorage.removeItem('forge_god_mode');
    window.history.replaceState({}, '', '/app/context-hub');
  }
})();


// Wrap protected app routes — redirects to Clerk sign-in if not authenticated
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut><RedirectToSignIn /></SignedOut>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
    <BrowserRouter>
      <Routes>
        {/* Marketing site */}
        <Route path="/" element={<Landing />} />

        {/* App — all product routes live under /app/ */}
        <Route
          path="/app/context-hub/*"
          element={<ProtectedRoute><AppProvider><ContextAgentPage /></AppProvider></ProtectedRoute>}
        />
        <Route path="/app/geo-strategist" element={<ProtectedRoute><AppProvider><GeoStrategistPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/authenticity-enricher" element={<ProtectedRoute><AppProvider><AuthenticityEnricherPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/content-generator" element={<ProtectedRoute><AppProvider><ContentGeneratorPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/campaign-generator" element={<ProtectedRoute><AppProvider><CampaignGeneratorPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/compliance-gate" element={<ProtectedRoute><AppProvider><ComplianceGatePage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/integrations" element={<ProtectedRoute><AppProvider><IntegrationsPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/publishing-queue" element={<ProtectedRoute><AppProvider><PublishingQueuePage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/performance" element={<ProtectedRoute><AppProvider><PerformanceDashboardPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/content-library" element={<ProtectedRoute><AppProvider><ContentLibraryPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/content-import" element={<ProtectedRoute><AppProvider><ContentImportPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/admin" element={<ProtectedRoute><AppProvider><AdminPage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/topic-queue" element={<ProtectedRoute><AppProvider><TopicQueuePage /></AppProvider></ProtectedRoute>} />
        <Route path="/app/brand-settings" element={<ProtectedRoute><AppProvider><BrandSettingsPage /></AppProvider></ProtectedRoute>} />

        {/* Public article viewer — no AppProvider needed */}
        <Route path="/articles/:brandSlug/:articleSlug" element={<PublicArticlePage />} />

        {/* External review page — no AppProvider, no auth */}
        <Route path="/review/:token" element={<ReviewPage />} />

        {/* Legacy redirects — keep old paths working during transition */}
        <Route path="/context-hub/*" element={<Navigate to="/app/context-hub" replace />} />
        <Route path="/geo-strategist" element={<Navigate to="/app/geo-strategist" replace />} />
        <Route path="/authenticity-enricher" element={<Navigate to="/app/authenticity-enricher" replace />} />
        <Route path="/content-generator" element={<Navigate to="/app/content-generator" replace />} />
        <Route path="/campaign-generator" element={<Navigate to="/app/campaign-generator" replace />} />
        <Route path="/compliance-gate" element={<Navigate to="/app/compliance-gate" replace />} />
        <Route path="/integrations" element={<Navigate to="/app/integrations" replace />} />
        <Route path="/publishing-queue" element={<Navigate to="/app/publishing-queue" replace />} />
        <Route path="/performance" element={<Navigate to="/app/performance" replace />} />
      </Routes>
    </BrowserRouter>
    </ClerkProvider>
  </StrictMode>
);
