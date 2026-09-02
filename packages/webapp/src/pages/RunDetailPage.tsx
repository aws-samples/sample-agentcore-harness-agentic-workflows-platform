/**
 * Run detail: live status header, task-progress bar, overview key-value
 * pairs (token usage / duration), tasks table with the pinned report row,
 * and an inline artifact viewer with markdown rendering and .md download.
 * Polls every 5s while running.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { api, type RunDetail, type TaskView } from '../api';
import Markdown from '../components/Markdown';
import { RunStatus, TaskStatus } from '../components/status';
import { durationBetween, formatCount, formatDateTime } from '../format';
import { useRecordVisit } from '../recents';
import { useShell } from '../shell/AppShell';

const POLL_MS = 5_000; // deliberate: polling, no WebSocket dependency

interface ArtifactState {
  key: string;
  text: string | null;
}

export default function RunDetailPage() {
  const { runId = '' } = useParams();
  const { setBreadcrumbs } = useShell();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [workflowName, setWorkflowName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.getRun(runId);
    setRun(result.run);
    setTasks(result.tasks);
    return result.run.status;
  }, [runId]);

  useEffect(() => {
    let timer: number | null = null;
    let cancelled = false;
    async function tick() {
      try {
        const status = await refresh();
        if (!cancelled && status === 'running') {
          timer = window.setTimeout(tick, POLL_MS);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'load failed');
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [refresh]);

  // Resolve the workflow name for breadcrumbs/recents (single extra call).
  useEffect(() => {
    if (!run?.workflowId) return;
    let cancelled = false;
    api
      .getWorkflow(run.workflowId)
      .then((result) => {
        if (!cancelled) setWorkflowName(result.workflow.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run?.workflowId]);

  const shortId = runId.slice(0, 8);

  useEffect(() => {
    if (!run) return;
    setBreadcrumbs([
      { text: 'Workflows', href: '/workflows' },
      { text: workflowName ?? run.workflowId.slice(0, 8), href: `/workflows/${run.workflowId}` },
      { text: `Run ${shortId}`, href: `/runs/${runId}` },
    ]);
  }, [setBreadcrumbs, run, workflowName, runId, shortId]);

  useRecordVisit(
    run
      ? {
          kind: 'run',
          id: runId,
          name: `Run ${shortId}${workflowName ? ` · ${workflowName}` : ''}`,
          href: `/runs/${runId}`,
        }
      : null,
  );

  async function openArtifact(key: string) {
    setArtifact({ key, text: null });
    setError(null);
    try {
      const { url } = await api.getArtifactUrl(runId, key);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`artifact fetch failed: HTTP ${response.status}`);
      }
      setArtifact({ key, text: await response.text() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'artifact fetch failed');
    }
  }

  function downloadArtifact() {
    if (!artifact?.text) return;
    const blob = new Blob([artifact.text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.key.split('/').pop() ?? 'artifact.md';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!run) {
    return (
      <ContentLayout>
        {error ? (
          <Alert type="error" header="Couldn't load this run">
            {error}
          </Alert>
        ) : (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        )}
      </ContentLayout>
    );
  }

  const workers = tasks.filter((task) => task.taskId !== '__report');
  const report = tasks.find((task) => task.taskId === '__report');
  const orderedTasks = report ? [...workers, report] : workers;
  const reportKey = report?.artifactKey ?? run.reportArtifactKey;

  const finished = tasks.filter((task) =>
    ['succeeded', 'failed', 'skipped'].includes(task.status),
  ).length;
  const percent = tasks.length > 0 ? Math.round((finished / tasks.length) * 100) : 0;
  const statusCounts = (['succeeded', 'running', 'pending', 'failed', 'skipped'] as const)
    .map((status) => ({ status, count: tasks.filter((task) => task.status === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`)
    .join(' · ');

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            workflowName ? `${workflowName} · trigger: ${run.trigger}` : `trigger: ${run.trigger}`
          }
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="refresh"
                onClick={() => void refresh().catch(() => undefined)}
                ariaLabel="Refresh run"
              />
              <Button
                variant="primary"
                disabled={!reportKey}
                disabledReason="The report artifact isn't available yet."
                onClick={() => reportKey && void openArtifact(reportKey)}
              >
                View report
              </Button>
            </SpaceBetween>
          }
        >
          Run {shortId}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Container header={<Header variant="h2">Overview</Header>}>
          <SpaceBetween size="l">
            <ProgressBar
              label="Task progress"
              value={percent}
              status={
                run.status === 'running'
                  ? 'in-progress'
                  : run.status === 'failed'
                    ? 'error'
                    : 'success'
              }
              resultText={
                run.status === 'succeeded'
                  ? 'All tasks finished'
                  : run.status === 'partial'
                    ? 'Finished with partial results — some tasks failed or were skipped'
                    : run.status === 'failed'
                      ? 'Run failed'
                      : undefined
              }
              additionalInfo={statusCounts || undefined}
            />
            {run.status === 'running' && (
              <StatusIndicator type="in-progress">
                Live — refreshing every {POLL_MS / 1000}s
              </StatusIndicator>
            )}
            <KeyValuePairs
              columns={4}
              items={[
                { label: 'Status', value: <RunStatus status={run.status} /> },
                { label: 'Plan version', value: `v${run.planVersion}` },
                { label: 'Started', value: formatDateTime(run.startedAt) },
                { label: 'Finished', value: formatDateTime(run.finishedAt) },
                { label: 'Duration', value: durationBetween(run.startedAt, run.finishedAt) },
                {
                  label: 'Tokens (in / out)',
                  value: `${formatCount(run.tokensInputTotal)} / ${formatCount(run.tokensOutputTotal)}`,
                },
                { label: 'Replanned at run time', value: run.replanned ? 'yes' : 'no' },
                { label: 'Trigger', value: run.trigger },
              ]}
            />
          </SpaceBetween>
        </Container>

        <Table
          items={orderedTasks}
          trackBy="taskId"
          header={
            <Header variant="h2" counter={`(${orderedTasks.length})`}>
              Tasks
            </Header>
          }
          columnDefinitions={[
            {
              id: 'task',
              header: 'Task',
              cell: (task) =>
                task.taskId === '__report' ? <Box fontWeight="bold">report</Box> : task.taskId,
            },
            { id: 'status', header: 'Status', cell: (task) => <TaskStatus status={task.status} /> },
            { id: 'detail', header: 'Detail', cell: (task) => task.statusReason ?? '—' },
            {
              id: 'tokens',
              header: 'Tokens (in / out)',
              cell: (task) =>
                task.tokens
                  ? `${formatCount(task.tokens.inputTokens)} / ${formatCount(task.tokens.outputTokens)}`
                  : '—',
            },
            {
              id: 'duration',
              header: 'Duration',
              cell: (task) => durationBetween(task.startedAt, task.finishedAt),
            },
            {
              id: 'output',
              header: 'Output',
              cell: (task) =>
                task.artifactKey ? (
                  <Button
                    variant="inline-link"
                    onClick={() => void openArtifact(task.artifactKey!)}
                  >
                    {task.taskId === '__report' ? 'View report' : 'View'}
                  </Button>
                ) : (
                  '—'
                ),
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit" padding="s">
              <Box color="text-body-secondary">No tasks recorded for this run.</Box>
            </Box>
          }
        />

        {artifact && (
          <Container
            header={
              <Header
                variant="h2"
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      iconName="download"
                      onClick={downloadArtifact}
                      disabled={!artifact.text}
                    >
                      Download .md
                    </Button>
                    <Button onClick={() => setArtifact(null)}>Close</Button>
                  </SpaceBetween>
                }
              >
                {artifact.key.split('/').slice(-2).join('/')}
              </Header>
            }
          >
            {artifact.text === null ? (
              <StatusIndicator type="loading">Loading artifact…</StatusIndicator>
            ) : (
              <Markdown text={artifact.text} />
            )}
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
