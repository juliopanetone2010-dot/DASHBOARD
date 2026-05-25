import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import Settings from "./pages/Settings.tsx";
import OAuthCallback from "./pages/OAuthCallback.tsx";
import Auth from "./pages/Auth.tsx";
import Admins from "./pages/Admins.tsx";
import AiSettings from "./pages/AiSettings.tsx";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { FloatingAi } from "@/components/ai/FloatingAi";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route path="/oauth/google-ads/callback" element={<OAuthCallback />} />
            <Route path="/" element={<RequireAuth><Index /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
            <Route path="/admins" element={<RequireAuth><Admins /></RequireAuth>} />
            <Route path="/ai-settings" element={<RequireAuth><AiSettings /></RequireAuth>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <FloatingAi />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
