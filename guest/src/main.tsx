import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { GuestListener } from './GuestListener';
import { Splash } from './Splash';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="/listen/:code" element={<GuestListener />} />
        <Route path="*" element={<Splash />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
