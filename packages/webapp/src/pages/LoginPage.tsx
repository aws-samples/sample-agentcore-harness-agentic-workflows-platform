import { FormEvent, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { completeNewPassword, signIn } from '../auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  // Session-expired banner + return-to-origin redirect (?expired=1 and
  // location.state.from).
  const expired = params.get('expired') === '1';
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = session
        ? await completeNewPassword(username, newPassword, session)
        : await signIn(username, password);
      if (result.ok) {
        navigate(from, { replace: true });
      } else if (result.newPasswordRequired && result.session) {
        setSession(result.session);
      } else {
        setError(result.error ?? 'sign-in failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <SpaceBetween size="l">
        <Box textAlign="center">
          <Box variant="h1">Agentic Workflows</Box>
          <Box variant="p" color="text-body-secondary">
            Plan, schedule, and monitor multi-agent research workflows.
          </Box>
        </Box>
        {expired && !error && (
          <Alert type="info">Your session expired. Sign in again to continue.</Alert>
        )}
        <Container
          header={
            <Header
              variant="h2"
              description={session ? 'First sign-in: choose a new password.' : undefined}
            >
              {session ? 'Choose a new password' : 'Sign in'}
            </Header>
          }
        >
          <form onSubmit={(event) => void onSubmit(event)}>
            <Form
              actions={
                <Button variant="primary" loading={busy} formAction="submit" fullWidth>
                  {session ? 'Set password & sign in' : 'Sign in'}
                </Button>
              }
              errorText={error ?? undefined}
            >
              <SpaceBetween size="l">
                <FormField label="Username" stretch>
                  <Input
                    value={username}
                    onChange={({ detail }) => setUsername(detail.value)}
                    autoComplete="username"
                    disabled={!!session}
                    autoFocus
                  />
                </FormField>
                {!session && (
                  <FormField label="Password" stretch>
                    <Input
                      type="password"
                      value={password}
                      onChange={({ detail }) => setPassword(detail.value)}
                      autoComplete="current-password"
                    />
                  </FormField>
                )}
                {session && (
                  <FormField label="New password" stretch>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={({ detail }) => setNewPassword(detail.value)}
                      autoComplete="new-password"
                      autoFocus
                    />
                  </FormField>
                )}
              </SpaceBetween>
            </Form>
          </form>
        </Container>
      </SpaceBetween>
    </div>
  );
}
