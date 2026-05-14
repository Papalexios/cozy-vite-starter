// src/App.tsx
// SOTA God Mode - App Root with Error Boundary v3.0

import React, { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SupabaseSyncProvider } from "@/providers/SupabaseSyncProvider";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
const Status = lazy(() => import("./pages/Status"));
const Perf = lazy(() => import("./pages/Perf"));
const SearchConsole = lazy(() => import("./pages/SearchConsole"));
const DomainVerification = lazy(() => import("./pages/DomainVerification"));

// ═══════════════════════════════════════════════════════════════════
// ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════════

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[AppErrorBoundary] Caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-8">
          <div className="max-w-lg text-center space-y-6">
            <div className="w-20 h-20 mx-auto rounded-full bg-red-500/20 flex items-center justify-center">
              <svg className="w-10 h-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold">Something went wrong</h1>
            <p className="text-muted-foreground">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2.5 bg-muted text-foreground rounded-lg font-medium hover:bg-muted/80 transition-colors"
              >
                Reload Page
              </button>
            </div>
            {process.env.NODE_ENV !== "production" && this.state.error?.stack && (
              <pre className="mt-4 text-left text-xs bg-muted/30 p-4 rounded-lg overflow-auto max-h-48 text-muted-foreground">
                {this.state.error.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════
// QUERY CLIENT
// ═══════════════════════════════════════════════════════════════════

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: {
      retry: 0,
    },
  },
});

// ═══════════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════════

const App = () => (
  <AppErrorBoundary>
    <div className="min-h-screen gradient-bg text-foreground">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SupabaseSyncProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route
                  path="/status"
                  element={
                    <Suspense fallback={<div className="p-8 text-muted-foreground">Loading status…</div>}>
                      <Status />
                    </Suspense>
                  }
                />
                <Route
                  path="/perf"
                  element={
                    <Suspense fallback={<div className="p-8 text-muted-foreground">Loading perf…</div>}>
                      <Perf />
                    </Suspense>
                  }
                />
                <Route
                  path="/search-console"
                  element={
                    <Suspense fallback={<div className="p-8 text-muted-foreground">Loading…</div>}>
                      <SearchConsole />
                    </Suspense>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </SupabaseSyncProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </div>
  </AppErrorBoundary>
);

export default App;
