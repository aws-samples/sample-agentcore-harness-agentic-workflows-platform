/**
 * Insights & review queue — TEMP/PREVIEW page.
 *
 * The target feature surfaces curation insights (quality signals,
 * remediation counts, fact distortions) with a human review queue for
 * improvement proposals (accept / reject / edit-and-accept). None of the
 * backing APIs exist in this platform yet, so this page describes what's
 * coming and stays clearly marked as a preview.
 */
import { useEffect } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useShell } from '../shell/AppShell';

export default function InsightsPage() {
  const { setBreadcrumbs } = useShell();

  useEffect(() => {
    setBreadcrumbs([{ text: 'Insights', href: '/insights' }]);
  }, [setBreadcrumbs]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Quality signals detected across runs, with proposed improvements for human review."
        >
          Insights <Badge color="blue">Coming soon</Badge>
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Alert type="info" header="This page is a preview">
          Insights need run-quality analysis APIs (and a review-decision endpoint) that the
          platform doesn&rsquo;t expose yet. The layout below shows what will land here.
        </Alert>
        <ColumnLayout columns={2}>
          <Container
            header={
              <Header variant="h2" actions={<Badge color="blue">Coming soon</Badge>}>
                Curation insights
              </Header>
            }
          >
            <SpaceBetween size="s">
              <Box color="text-body-secondary">
                Detected problems across workflows and runs, each with evidence:
              </Box>
              <Box color="text-body-secondary">
                · Low-quality outputs (weak report scores)
                <br />
                · High remediation counts on recurring tasks
                <br />
                · Repeated manual edits to the same artifact type
                <br />· Fact distortions caught by verification
              </Box>
            </SpaceBetween>
          </Container>
          <Container
            header={
              <Header variant="h2" actions={<Badge color="blue">Coming soon</Badge>}>
                Review queue
              </Header>
            }
          >
            <SpaceBetween size="s">
              <Box color="text-body-secondary">
                Improvement proposals (for example, prompt or tool-scope changes) queued for a
                human decision:
              </Box>
              <Box color="text-body-secondary">
                · Accept, reject, or edit &amp; accept each proposal
                <br />
                · Full audit of who decided what, and when
                <br />· Conflict-safe: proposals already decided elsewhere refresh in place
              </Box>
            </SpaceBetween>
          </Container>
        </ColumnLayout>
      </SpaceBetween>
    </ContentLayout>
  );
}
