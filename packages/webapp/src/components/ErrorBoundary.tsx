import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import React from 'react';

interface State {
  error: Error | null;
}

/**
 * Last-resort boundary around the app. Without one, any exception thrown
 * while rendering unmounts the whole React tree and the page goes blank with
 * nothing to act on (live finding: a report edit proposal "didn't render").
 * This keeps the failure visible and recoverable, and exposes the message so
 * it can be reported.
 */
export default class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Box padding="xl">
        <Alert
          type="error"
          header="Something went wrong while drawing this page"
          action={<Button onClick={() => window.location.reload()}>Reload</Button>}
        >
          <SpaceBetween size="xs">
            <div>
              Reloading usually fixes this, especially right after an update. If it keeps
              happening, include the message below when reporting it.
            </div>
            <Box variant="code" fontSize="body-s">
              {this.state.error.message}
            </Box>
          </SpaceBetween>
        </Alert>
      </Box>
    );
  }
}
