import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './style.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 未找到');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
