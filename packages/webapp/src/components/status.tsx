/** Run/task status mapped onto Cloudscape StatusIndicator types. */
import StatusIndicator, {
  type StatusIndicatorProps,
} from '@cloudscape-design/components/status-indicator';
import type { RunSummary, TaskView } from '../api';

const RUN_TYPE: Record<RunSummary['status'], StatusIndicatorProps.Type> = {
  running: 'in-progress',
  succeeded: 'success',
  partial: 'warning',
  failed: 'error',
};

const TASK_TYPE: Record<TaskView['status'], StatusIndicatorProps.Type> = {
  pending: 'pending',
  running: 'in-progress',
  succeeded: 'success',
  failed: 'error',
  skipped: 'stopped',
};

export function RunStatus({ status }: { status: RunSummary['status'] }) {
  return <StatusIndicator type={RUN_TYPE[status]}>{status}</StatusIndicator>;
}

export function TaskStatus({ status }: { status: TaskView['status'] }) {
  return <StatusIndicator type={TASK_TYPE[status]}>{status}</StatusIndicator>;
}
