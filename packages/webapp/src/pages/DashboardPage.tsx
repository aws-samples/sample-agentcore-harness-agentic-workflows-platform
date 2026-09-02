/**
 * Dashboard: greeting with counts, KPI strip, "continue where you left off"
 * card, workflow portfolio grid, and a recent-runs rail. The live activity
 * feed is a placeholder — the platform API has no event stream yet.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api, type RunSummary, type WorkflowSummary } from '../api';
import { displayName } from '../auth';
import CreateWorkflowModal from '../components/CreateWorkflowModal';
import { RunStatus } from '../components/status';
import { timeAgo, truncate } from '../format';
import { useShell } from '../shell/AppShell';

/** How many recent workflows to sample runs from (the API lists runs per workflow). */
const RUN_SAMPLE = 8;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box fontSize="display-l" fontWeight="bold">
        {value}
      </Box>
      {sub && (
        <Box color="text-body-secondary" fontSize="body-s">
          {sub}
        </Box>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useShell();
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { workflows: list } = await api.listWorkflows();
      const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setWorkflows(sorted);
      const sample = sorted.slice(0, RUN_SAMPLE);
      const runLists = await Promise.all(
        sample.map((workflow) =>
          api
            .listRuns(workflow.workflowId)
            .then((result) => result.runs)
            .catch(() => [] as RunSummary[]),
        ),
      );
      setRuns(runLists.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const workflowNames = useMemo(
    () => new Map((workflows ?? []).map((workflow) => [workflow.workflowId, workflow.name])),
    [workflows],
  );

  // KPIs derived client-side (honest about their sample size).
  const kpis = useMemo(() => {
    const total = workflows?.length ?? 0;
    const scheduled = (workflows ?? []).filter((w) => w.schedule?.enabled).length;
    const recentRuns = (runs ?? []).filter(
      (run) => Date.now() - new Date(run.startedAt).getTime() < SEVEN_DAYS_MS,
    ).length;
    const terminal = (runs ?? []).filter((run) => run.status !== 'running');
    const successRate =
      terminal.length > 0
        ? `${Math.round((terminal.filter((run) => run.status === 'succeeded').length / terminal.length) * 100)}%`
        : '—';
    return { total, scheduled, recentRuns, successRate };
  }, [workflows, runs]);

  const continueWorkflow = workflows?.[0];
  const cardItems = (workflows ?? []).slice(0, 6);
  const recentRuns = (runs ?? []).slice(0, 6);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            workflows
              ? `${kpis.total} workflow${kpis.total === 1 ? '' : 's'} · ${kpis.recentRuns} run${
                  kpis.recentRuns === 1 ? '' : 's'
                } in the last 7 days`
              : 'Loading your workspace…'
          }
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => void load()} ariaLabel="Refresh dashboard" />
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create workflow
              </Button>
            </SpaceBetween>
          }
        >
          {greeting()}, {displayName()}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert
            type="error"
            header="Couldn't load the dashboard"
            action={<Button onClick={() => void load()}>Retry</Button>}
          >
            {error}
          </Alert>
        )}

        <Container>
          <ColumnLayout columns={4} variant="text-grid" minColumnWidth={150}>
            <Kpi label="Workflows" value={loading ? '…' : String(kpis.total)} />
            <Kpi label="Active schedules" value={loading ? '…' : String(kpis.scheduled)} />
            <Kpi
              label="Runs (7 days)"
              value={loading ? '…' : String(kpis.recentRuns)}
              sub={`across the ${Math.min(kpis.total, RUN_SAMPLE)} most recent workflows`}
            />
            <Kpi
              label="Success rate"
              value={loading ? '…' : kpis.successRate}
              sub="of finished runs in sample"
            />
          </ColumnLayout>
        </Container>

        <Grid
          gridDefinition={[
            { colspan: { default: 12, m: 8 } },
            { colspan: { default: 12, m: 4 } },
          ]}
        >
          <SpaceBetween size="l">
            {continueWorkflow && (
              <Container
                header={
                  <Header
                    variant="h2"
                    actions={
                      <Button onClick={() => navigate(`/workflows/${continueWorkflow.workflowId}`)}>
                        Open workflow
                      </Button>
                    }
                  >
                    Pick up where you left off
                  </Header>
                }
              >
                <SpaceBetween size="xs">
                  <Link
                    fontSize="heading-m"
                    onFollow={(event) => {
                      event.preventDefault();
                      navigate(`/workflows/${continueWorkflow.workflowId}`);
                    }}
                    href={`/workflows/${continueWorkflow.workflowId}`}
                  >
                    {continueWorkflow.name}
                  </Link>
                  <Box color="text-body-secondary">{truncate(continueWorkflow.goal, 160)}</Box>
                  <Box>
                    {continueWorkflow.latestVersion >= 1 ? (
                      <StatusIndicator type="success">
                        plan v{continueWorkflow.latestVersion} saved
                      </StatusIndicator>
                    ) : (
                      <StatusIndicator type="pending">no plan yet — draft one</StatusIndicator>
                    )}
                  </Box>
                </SpaceBetween>
              </Container>
            )}

            <Cards
              items={cardItems}
              trackBy="workflowId"
              loading={loading}
              loadingText="Loading workflows"
              cardsPerRow={[{ cards: 1 }, { minWidth: 560, cards: 2 }]}
              header={
                <Header
                  variant="h2"
                  counter={workflows ? `(${workflows.length})` : undefined}
                  actions={
                    <Button variant="inline-link" onClick={() => navigate('/workflows')}>
                      View all
                    </Button>
                  }
                >
                  Your workflows
                </Header>
              }
              cardDefinition={{
                header: (item) => (
                  <Link
                    fontSize="heading-m"
                    href={`/workflows/${item.workflowId}`}
                    onFollow={(event) => {
                      event.preventDefault();
                      navigate(`/workflows/${item.workflowId}`);
                    }}
                  >
                    {item.name}
                  </Link>
                ),
                sections: [
                  {
                    id: 'goal',
                    header: 'Goal',
                    content: (item) => truncate(item.goal, 120),
                  },
                  {
                    id: 'plan',
                    header: 'Plan',
                    content: (item) =>
                      item.latestVersion >= 1 ? (
                        <StatusIndicator type="success">
                          v{item.latestVersion}
                          {item.planMode === 'replan-each-run' ? ' (replan each run)' : ''}
                        </StatusIndicator>
                      ) : (
                        <StatusIndicator type="pending">pending</StatusIndicator>
                      ),
                  },
                  {
                    id: 'schedule',
                    header: 'Schedule',
                    content: (item) =>
                      item.schedule
                        ? `${item.schedule.expression}${item.schedule.enabled ? '' : ' (off)'}`
                        : '—',
                  },
                ],
              }}
              empty={
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <b>No workflows yet</b>
                    <Box color="text-body-secondary">
                      Describe a goal and the planner drafts the agent workflow for review.
                    </Box>
                    <Button onClick={() => setCreateOpen(true)}>Create workflow</Button>
                  </SpaceBetween>
                </Box>
              }
            />
          </SpaceBetween>

          <SpaceBetween size="l">
            <Table
              variant="container"
              items={recentRuns}
              trackBy="runId"
              loading={loading}
              loadingText="Loading runs"
              header={
                <Header variant="h2" counter={runs ? `(${recentRuns.length})` : undefined}>
                  Recent runs
                </Header>
              }
              columnDefinitions={[
                {
                  id: 'run',
                  header: 'Run',
                  cell: (run) => (
                    <Link
                      href={`/runs/${run.runId}`}
                      onFollow={(event) => {
                        event.preventDefault();
                        navigate(`/runs/${run.runId}`);
                      }}
                    >
                      {workflowNames.get(run.workflowId) ?? run.workflowId.slice(0, 8)}
                    </Link>
                  ),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (run) => <RunStatus status={run.status} />,
                },
                {
                  id: 'started',
                  header: 'Started',
                  cell: (run) => timeAgo(run.startedAt),
                },
              ]}
              empty={
                <Box textAlign="center" color="inherit" padding="s">
                  <Box color="text-body-secondary">No runs yet.</Box>
                </Box>
              }
            />

            {/* Placeholder: a live activity feed needs an event stream the
                platform API doesn't expose yet. */}
            <Container
              header={
                <Header variant="h2" actions={<Badge color="blue">Coming soon</Badge>}>
                  Live activity
                </Header>
              }
            >
              <Box color="text-body-secondary">
                A live event feed needs a streaming API that the platform doesn&rsquo;t expose yet.
                Until then, workflow and run pages refresh automatically every few seconds.
              </Box>
            </Container>
          </SpaceBetween>
        </Grid>
      </SpaceBetween>
      <CreateWorkflowModal visible={createOpen} onDismiss={() => setCreateOpen(false)} />
    </ContentLayout>
  );
}
