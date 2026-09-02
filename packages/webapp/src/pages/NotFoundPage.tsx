import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useShell } from '../shell/AppShell';

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useShell();

  useEffect(() => {
    setBreadcrumbs([{ text: 'Page not found', href: '#' }]);
  }, [setBreadcrumbs]);

  return (
    <ContentLayout>
      <Container>
        <Box textAlign="center" padding="xxl">
          <SpaceBetween size="m">
            <Box variant="h1">Page not found</Box>
            <Box color="text-body-secondary">
              The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
            </Box>
            <Box>
              <Button onClick={() => navigate('/')}>Back to dashboard</Button>
            </Box>
          </SpaceBetween>
        </Box>
      </Container>
    </ContentLayout>
  );
}
