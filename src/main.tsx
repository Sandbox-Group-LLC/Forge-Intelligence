import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Landing from './Landing';
import ContextAgentPage from './pages/ContextAgentPage';
import GeoStrategistPage from './pages/GeoStrategistPage';
import AuthenticityEnricherPage from './pages/AuthenticityEnricherPage';
import ContentGeneratorPage from './pages/ContentGeneratorPage';
import CampaignGeneratorPage from './pages/CampaignGeneratorPage';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/context-hub/*"
          element={
            <AppProvider>
              <ContextAgentPage />
            </AppProvider>
          }
        />
        <Route path="/geo-strategist" element={<AppProvider><GeoStrategistPage /></AppProvider>} />
        <Route path="/authenticity-enricher" element={<AppProvider><AuthenticityEnricherPage /></AppProvider>} />
        <Route path="/content-generator" element={<AppProvider><ContentGeneratorPage /></AppProvider>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
