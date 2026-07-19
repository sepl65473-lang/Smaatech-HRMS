import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { HRMSProvider } from './context/HRMSContext.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <HRMSProvider>
            <App />
          </HRMSProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)


// PWA: lets employees install this as an app (Add to Home Screen) with an
// offline-capable shell. Registered post-load so it never delays first paint.
// Production only — during `npm run dev` the app changes on every save, and a
// service worker caching those responses would serve stale/broken content
// instead of Vite's live dev server.
if (import.meta.env.PROD) {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
} else if ('serviceWorker' in navigator) {
  // Self-heal any service worker/cache left behind by earlier testing of the
  // production build, so dev mode can never get stuck on stale content.
  navigator.serviceWorker.getRegistrations().then(async (regs) => {
    if (regs.length === 0) return;
    await Promise.all(regs.map((reg) => reg.unregister()));
    if (window.caches) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    // A brief pause lets the cache deletion actually commit before we tear
    // down the page — navigating immediately after can abort it mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Per the service worker spec, unregister() only stops a worker from
    // controlling FUTURE loads — it may still control this exact page. One
    // reload guarantees the user lands on a genuinely clean page automatically.
    window.location.reload();
  });
}
