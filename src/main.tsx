import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';
// StartupAtlas is its own tab with its own look, loaded only on /startups so
// the contract feed's bundle and styles stay as they were.
const StartupAtlas=lazy(()=>import('./startup/StartupAtlas'));
const startups=/^\/startups(\/|$)/.test(window.location.pathname);
const queryClient=new QueryClient({defaultOptions:{queries:{staleTime:30_000,retry:1,refetchOnWindowFocus:true}}});
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}>{startups?<Suspense fallback={null}><StartupAtlas/></Suspense>:<App/>}</QueryClientProvider></React.StrictMode>);
