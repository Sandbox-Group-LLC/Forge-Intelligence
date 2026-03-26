import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Landing from './Landing';
import ContextAgentPage from './pages/ContextAgentPage';
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
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
