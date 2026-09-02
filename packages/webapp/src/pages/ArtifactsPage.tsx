/**
 * Artifact library — TEMP/PREVIEW page.
 *
 * A full artifact library — faceted filters, saved views, and export
 * actions — needs a cross-workflow artifact listing API that the platform
 * doesn't expose yet
 * (artifacts are only reachable per run via presigned URLs). This page ships
 * the Cloudscape shell for that feature with an honest empty state.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useShell } from '../shell/AppShell';

interface ArtifactRow {
  artifact: string;
  workflow: string;
  run: string;
  task: string;
  created: string;
}

export default function ArtifactsPage() {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useShell();

  useEffect(() => {
    setBreadcrumbs([{ text: 'Artifact library', href: '/artifacts' }]);
  }, [setBreadcrumbs]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Browse every artifact produced across workflows and runs — filter by workflow, run, and date."
        >
          Artifact library <Badge color="blue">Coming soon</Badge>
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Alert type="info" header="This page is a preview">
          The artifact library needs a cross-workflow artifact listing API that the platform
          doesn&rsquo;t expose yet. Today, artifacts are available from each run&rsquo;s detail
          page (open a workflow, then a run, then &ldquo;View&rdquo; on a task).
        </Alert>
        <Table<ArtifactRow>
          items={[]}
          columnDefinitions={[
            { id: 'artifact', header: 'Artifact', cell: (row) => row.artifact },
            { id: 'workflow', header: 'Workflow', cell: (row) => row.workflow },
            { id: 'run', header: 'Run', cell: (row) => row.run },
            { id: 'task', header: 'Task', cell: (row) => row.task },
            { id: 'created', header: 'Created', cell: (row) => row.created },
          ]}
          filter={
            <TextFilter
              filteringText=""
              disabled
              filteringPlaceholder="Filtering will arrive with the artifact API"
            />
          }
          empty={
            <Box textAlign="center" color="inherit">
              <SpaceBetween size="m">
                <b>Nothing to list yet</b>
                <Box color="text-body-secondary">
                  Artifacts will appear here once the listing API lands.
                </Box>
                <Button onClick={() => navigate('/workflows')}>Browse workflows instead</Button>
              </SpaceBetween>
            </Box>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
