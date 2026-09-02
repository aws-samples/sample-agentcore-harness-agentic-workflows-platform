/**
 * Workflow list as a Cloudscape table view with the full list-page toolbar:
 * search filter, sort, density + page-size preferences (persisted), count
 * summary, empty/error/loading states, and a create flow.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCollection } from '@cloudscape-design/collection-hooks';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import CollectionPreferences, {
  type CollectionPreferencesProps,
} from '@cloudscape-design/components/collection-preferences';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Pagination from '@cloudscape-design/components/pagination';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { api, type WorkflowSummary } from '../api';
import CreateWorkflowModal from '../components/CreateWorkflowModal';
import { truncate } from '../format';
import { useShell } from '../shell/AppShell';

const PREFS_KEY = 'agentic.workflows.prefs';

type Prefs = CollectionPreferencesProps.Preferences;

const DEFAULT_PREFS: Prefs = {
  pageSize: 10,
  wrapLines: false,
  stripedRows: false,
  contentDensity: 'comfortable',
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Prefs) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useShell();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [preferences, setPreferences] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    setBreadcrumbs([{ text: 'Workflows', href: '/workflows' }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    } catch {
      // preference simply won't persist
    }
  }, [preferences]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listWorkflows();
      setWorkflows(result.workflows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { items, actions, filteredItemsCount, collectionProps, filterProps, paginationProps } =
    useCollection(workflows, {
      filtering: {
        empty: (
          <Box textAlign="center" color="inherit">
            <SpaceBetween size="m">
              <b>No workflows</b>
              <Box color="text-body-secondary">
                Describe a goal and the planner drafts the agent workflow for review.
              </Box>
              <Button onClick={() => setCreateOpen(true)}>Create workflow</Button>
            </SpaceBetween>
          </Box>
        ),
        noMatch: (
          <Box textAlign="center" color="inherit">
            <SpaceBetween size="m">
              <b>No matches</b>
              <Button onClick={() => actions.setFiltering('')}>Clear filter</Button>
            </SpaceBetween>
          </Box>
        ),
      },
      pagination: { pageSize: preferences.pageSize ?? 10 },
      sorting: {
        defaultState: { sortingColumn: { sortingField: 'createdAt' }, isDescending: true },
      },
    });

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${workflows.length})`}
          description="Each workflow captures a research goal, a reviewed plan, and a schedule."
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => void load()} ariaLabel="Refresh workflows" />
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create workflow
              </Button>
            </SpaceBetween>
          }
        >
          Workflows
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert
            type="error"
            header="Couldn't load workflows"
            action={<Button onClick={() => void load()}>Retry</Button>}
          >
            {error}
          </Alert>
        )}
        <Table
          {...collectionProps}
          items={items}
          trackBy="workflowId"
          loading={loading}
          loadingText="Loading workflows"
          wrapLines={preferences.wrapLines}
          stripedRows={preferences.stripedRows}
          contentDensity={preferences.contentDensity as 'comfortable' | 'compact' | undefined}
          onRowClick={({ detail }) => navigate(`/workflows/${detail.item.workflowId}`)}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Name',
              sortingField: 'name',
              cell: (item) => (
                <Link
                  href={`/workflows/${item.workflowId}`}
                  onFollow={(event) => {
                    event.preventDefault();
                    navigate(`/workflows/${item.workflowId}`);
                  }}
                >
                  {item.name}
                </Link>
              ),
            },
            {
              id: 'goal',
              header: 'Goal',
              cell: (item) => truncate(item.goal, 100),
            },
            {
              id: 'plan',
              header: 'Plan',
              cell: (item) =>
                item.latestVersion >= 1 ? (
                  <StatusIndicator type="success">
                    v{item.latestVersion}
                    {item.planMode === 'replan-each-run' ? ' (replan)' : ''}
                  </StatusIndicator>
                ) : (
                  <StatusIndicator type="pending">pending</StatusIndicator>
                ),
            },
            {
              id: 'schedule',
              header: 'Schedule',
              cell: (item) =>
                item.schedule
                  ? `${item.schedule.expression}${item.schedule.enabled ? '' : ' (off)'}`
                  : '—',
            },
            {
              id: 'createdAt',
              header: 'Created',
              sortingField: 'createdAt',
              cell: (item) => new Date(item.createdAt).toLocaleDateString(),
            },
          ]}
          filter={
            <TextFilter
              {...filterProps}
              filteringPlaceholder="Find workflows by name or goal"
              countText={
                filteredItemsCount !== undefined
                  ? `${filteredItemsCount} match${filteredItemsCount === 1 ? '' : 'es'}`
                  : ''
              }
            />
          }
          pagination={<Pagination {...paginationProps} />}
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              preferences={preferences}
              onConfirm={({ detail }) => setPreferences(detail)}
              pageSizePreference={{
                title: 'Page size',
                options: [
                  { value: 10, label: '10 workflows' },
                  { value: 20, label: '20 workflows' },
                  { value: 50, label: '50 workflows' },
                ],
              }}
              wrapLinesPreference={{
                label: 'Wrap lines',
                description: 'Wrap long goal text within cells.',
              }}
              stripedRowsPreference={{
                label: 'Striped rows',
                description: 'Shade alternate rows.',
              }}
              contentDensityPreference={{
                label: 'Compact mode',
                description: 'Reduce row padding.',
              }}
            />
          }
        />
      </SpaceBetween>
      <CreateWorkflowModal visible={createOpen} onDismiss={() => setCreateOpen(false)} />
    </ContentLayout>
  );
}
