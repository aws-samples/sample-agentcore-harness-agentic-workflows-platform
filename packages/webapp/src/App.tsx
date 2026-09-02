import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { currentToken } from './auth';
import ArtifactsPage from './pages/ArtifactsPage';
import DashboardPage from './pages/DashboardPage';
import InsightsPage from './pages/InsightsPage';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import RunDetailPage from './pages/RunDetailPage';
import SettingsPage from './pages/SettingsPage';
import WorkflowDetailPage from './pages/WorkflowDetailPage';
import WorkflowsPage from './pages/WorkflowsPage';
import AppShell from './shell/AppShell';

function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation();
  if (!currentToken()) {
    // Preserve the intended destination so login can return the user there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/artifacts" element={<ArtifactsPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
