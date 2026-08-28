import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { store } from './store.ts';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
  void store.init();
}
