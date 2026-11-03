import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { store } from './store.ts';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <ErrorBoundary label="harness">
      <App />
    </ErrorBoundary>,
  );
  void store.init();
}
