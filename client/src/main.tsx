import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import App from './App';
import './styles/index.css';
import { AuthProvider } from './auth/AuthContext';
import { isPublicSharePath } from './components/sharing/public-share-route';
import { ThemeProvider } from './theme/ThemeContext';

function ApplicationProviders() {
  const location = useLocation();
  return (
    <AuthProvider skipInitialCheck={isPublicSharePath(location.pathname)}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AuthProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ApplicationProviders />
    </BrowserRouter>
  </React.StrictMode>
);
