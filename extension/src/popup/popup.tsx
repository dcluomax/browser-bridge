import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './popup.css';
import { PopupApp } from './PopupApp.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Popup root element is missing.');
createRoot(root).render(<PopupApp />);
