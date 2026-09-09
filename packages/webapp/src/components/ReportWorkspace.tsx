/**
 * ReportWorkspace — the report viewer, its version history, a Markdown
 * editor, and the "Ask the report" chat, sharing one piece of state: the
 * report text currently on screen.
 *
 * Editing model (section-scoped, human-in-the-loop):
 *   - The chat agent may return an edit proposal for ONE section. We show
 *     the current vs proposed section side by side; nothing is written until
 *     the user chooses "Apply to editor" (review/tweak, then Save) or
 *     "Save as new version" (one click).
 *   - Manual edits use the same editor and the same save path.
 *   - Saves create report.v<n>.md; the generated original is never
 *     overwritten. `baseVersion` gives optimistic concurrency (409 → reload).
 *   - Editing is offered to the workflow owner or an org admin (mirrors the
 *     API's owner-or-admin rule; the server enforces it regardless).
 */
import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import PromptInput from '@cloudscape-design/components/prompt-input';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import {
  extractReportSection,
  findReportSection,
  replaceReportSection,
} from '@agentic-platform/plan-schema';
import {
  api,
  ApiError,
  type ChatMessage,
  type ProposedEdit,
  type ReportVersion,
} from '../api';
import { formatDateTime } from '../format';
import Markdown from './Markdown';

export interface ReportWorkspaceProps {
  runId: string;
  /** Latest report key from the run record (v1 until an edit is saved). */
  reportArtifactKey: string;
  /** Edit history from the run record; absent for never-edited runs. */
  reportVersions?: ReportVersion[];
  /** Whether the signed-in user may save edits (owner or admin). */
  canEdit: boolean;
  /** Called after a successful save so the page can refresh run state. */
  onSaved?: () => void;
}

interface LoadedReport {
  version: number;
  key: string;
  text: string;
}

export default function ReportWorkspace(props: ReportWorkspaceProps) {
  const { runId, canEdit } = props;
  // Versions as the server sees them; synthesize v1 for legacy runs.
  const versions = useMemo<ReportVersion[]>(
    () =>
      props.reportVersions && props.reportVersions.length > 0
        ? props.reportVersions
        : [{ version: 1, artifactKey: props.reportArtifactKey, savedAt: '' }],
    [props.reportVersions, props.reportArtifactKey],
  );
  const latest = versions[versions.length - 1]!;

  const [selectedVersion, setSelectedVersion] = useState<number>(latest.version);
  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editor
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  // Follow the latest version when a save (ours or someone else's) lands.
  useEffect(() => {
    setSelectedVersion(latest.version);
  }, [latest.version]);

  // Load the selected version's text via a presigned URL.
  useEffect(() => {
    const target = versions.find((entry) => entry.version === selectedVersion) ?? latest;
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    (async () => {
      try {
        const { url } = await api.getArtifactUrl(runId, target.artifactKey);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`report fetch failed: HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!cancelled) {
          setLoaded({ version: target.version, key: target.artifactKey, text });
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'report fetch failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, selectedVersion, versions, latest]);

  const viewingLatest = selectedVersion === latest.version;

  function startEditing(initial?: string) {
    if (!loaded) return;
    setDraft(initial ?? loaded.text);
    setNote('');
    setSaveError(null);
    setSavedVersion(null);
    setEditing(true);
  }

  async function save(markdown: string, changeNote?: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.putReport(runId, {
        markdown,
        baseVersion: latest.version,
        ...(changeNote?.trim() ? { note: changeNote.trim() } : {}),
      });
      setSavedVersion(result.version.version);
      setEditing(false);
      props.onSaved?.();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaveError(
          `${e.message} Your text is still in the editor — reload the page to pick up the latest version, then reapply your change.`,
        );
      } else if (e instanceof ApiError && e.status === 403) {
        setSaveError('Only the workflow owner or an org admin can save report edits.');
      } else {
        setSaveError(e instanceof Error ? e.message : 'save failed');
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Apply a chat proposal into the editor for review (on the latest text). */
  function applyProposalToEditor(edit: ProposedEdit) {
    if (!loaded) return;
    const spliced = replaceReportSection(loaded.text, edit.heading, edit.newMarkdown);
    if (!spliced.ok) {
      setSaveError(`Couldn't apply the proposal: ${spliced.error}`);
      return;
    }
    setSelectedVersion(latest.version);
    startEditing(spliced.markdown);
    setNote(edit.rationale ?? `Revised ${edit.heading.replace(/^#+\s*/, '')}`);
  }

  /** One-click: splice and save the proposal as a new version. */
  async function saveProposal(edit: ProposedEdit) {
    if (!loaded) return false;
    const spliced = replaceReportSection(loaded.text, edit.heading, edit.newMarkdown);
    if (!spliced.ok) {
      setSaveError(`Couldn't apply the proposal: ${spliced.error}`);
      return false;
    }
    return save(
      spliced.markdown,
      edit.rationale ?? `Revised ${edit.heading.replace(/^#+\s*/, '')}`,
    );
  }

  const versionOptions: SelectProps.Option[] = [...versions]
    .reverse()
    .map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version}${entry.version === latest.version ? ' (latest)' : ''}`,
      description:
        entry.version === 1
          ? 'Generated by the workflow'
          : `${entry.savedBy ?? 'unknown'} · ${formatDateTime(entry.savedAt)}${entry.note ? ` · ${entry.note}` : ''}`,
    }));

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              viewingLatest
                ? undefined
                : `Viewing an older version. Edits always start from v${latest.version}.`
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {versions.length > 1 && (
                  <Select
                    selectedOption={
                      versionOptions.find((o) => o.value === String(selectedVersion)) ?? null
                    }
                    onChange={({ detail }) =>
                      setSelectedVersion(Number(detail.selectedOption.value))
                    }
                    options={versionOptions}
                    disabled={editing}
                    ariaLabel="Report version"
                  />
                )}
                <Button
                  iconName="download"
                  disabled={!loaded}
                  onClick={() => loaded && downloadMarkdown(loaded)}
                >
                  Download .md
                </Button>
                {canEdit && !editing && (
                  <Button
                    iconName="edit"
                    disabled={!loaded || !viewingLatest}
                    disabledReason={
                      !viewingLatest ? 'Switch to the latest version to edit.' : undefined
                    }
                    onClick={() => startEditing()}
                  >
                    Edit
                  </Button>
                )}
              </SpaceBetween>
            }
          >
            Report
          </Header>
        }
      >
        <SpaceBetween size="m">
          {savedVersion !== null && (
            <Alert type="success" dismissible onDismiss={() => setSavedVersion(null)}>
              Saved as v{savedVersion}.
            </Alert>
          )}
          {saveError && (
            <Alert type="error" dismissible onDismiss={() => setSaveError(null)}>
              {saveError}
            </Alert>
          )}
          {loadError && <Alert type="error">{loadError}</Alert>}
          {!loaded && !loadError && (
            <StatusIndicator type="loading">Loading report…</StatusIndicator>
          )}
          {loaded && !editing && <Markdown text={loaded.text} />}
          {loaded && editing && (
            <SpaceBetween size="m">
              <FormField
                label="Report markdown"
                description={`Editing from v${latest.version}. Saving creates v${latest.version + 1}; earlier versions are kept.`}
                stretch
              >
                <Textarea
                  value={draft}
                  onChange={({ detail }) => setDraft(detail.value)}
                  rows={24}
                  spellcheck
                  disabled={saving}
                />
              </FormField>
              <FormField label="Change note" description="Optional, shown in the version history.">
                <Input
                  value={note}
                  onChange={({ detail }) => setNote(detail.value)}
                  placeholder="e.g. Tightened the executive summary"
                  disabled={saving}
                />
              </FormField>
              <ExpandableSection headerText="Preview">
                <Markdown text={draft} />
              </ExpandableSection>
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={draft.trim().length === 0 || draft === loaded.text}
                  onClick={() => void save(draft, note)}
                >
                  Save as v{latest.version + 1}
                </Button>
                <Button disabled={saving} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>

      <ReportChat
        runId={runId}
        currentText={loaded?.text ?? null}
        latestVersion={latest.version}
        canEdit={canEdit}
        busyElsewhere={saving}
        onApplyToEditor={applyProposalToEditor}
        onSaveProposal={saveProposal}
      />
    </SpaceBetween>
  );
}

function downloadMarkdown(report: LoadedReport) {
  const blob = new Blob([report.text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download =
    report.version === 1 ? 'report.md' : `report.v${report.version}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ───────────────────────────────────────────────────────────────────────────

interface ReportChatProps {
  runId: string;
  /** The latest report text on screen, for rendering proposal diffs. */
  currentText: string | null;
  latestVersion: number;
  canEdit: boolean;
  busyElsewhere: boolean;
  onApplyToEditor: (edit: ProposedEdit) => void;
  onSaveProposal: (edit: ProposedEdit) => Promise<boolean>;
}

/**
 * Ask-the-report chat. Stateless on the wire (the full transcript is sent
 * each turn); answers are grounded in the report and its task outputs by the
 * dedicated report_chat agent, which may attach one section-edit proposal.
 */
function ReportChat(props: ReportChatProps) {
  const { runId, currentText, canEdit } = props;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [answeredVersion, setAnsweredVersion] = useState<number | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());

  async function send() {
    const question = draft.trim();
    if (!question || busy) {
      return;
    }
    const history: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(history);
    setDraft('');
    setChatError(null);
    setBusy(true);
    try {
      const { message, reportVersion } = await api.chatAboutReport(runId, history);
      setMessages((current) => [...current, message]);
      setAnsweredVersion(reportVersion);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setChatError('The report for this run isn’t available yet.');
      } else if (e instanceof ApiError && e.status === 503) {
        setChatError('Report chat isn’t enabled for this deployment.');
      } else {
        setChatError(e instanceof Error ? e.message : 'chat failed');
      }
    } finally {
      setBusy(false);
    }
  }

  const stale = answeredVersion !== null && answeredVersion !== props.latestVersion;

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            canEdit
              ? 'Ask questions, or ask for a change — the assistant proposes section edits you can review and save as a new version.'
              : 'Ask questions about this report. Answers are grounded in the report and the task outputs behind it.'
          }
          actions={
            messages.length > 0 ? (
              <Button
                iconName="remove"
                disabled={busy}
                onClick={() => {
                  setMessages([]);
                  setChatError(null);
                  setApplied(new Set());
                }}
              >
                Clear
              </Button>
            ) : undefined
          }
        >
          Ask the report
        </Header>
      }
    >
      <SpaceBetween size="m">
        {stale && (
          <Alert type="info">
            The report has been updated to v{props.latestVersion} since the last answer. New
            answers use the latest version.
          </Alert>
        )}
        {messages.length === 0 ? (
          <Box color="text-body-secondary">
            Try “Summarize the key findings”, “Where did the 12% figure come from?”
            {canEdit ? ', or “Rewrite the executive summary to lead with the risks”.' : '.'}
          </Box>
        ) : (
          <SpaceBetween size="m">
            {messages.map((message, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{ maxWidth: message.proposedEdit ? '100%' : '85%', width: message.proposedEdit ? '100%' : undefined }}>
                  <Box
                    fontSize="body-s"
                    color="text-body-secondary"
                    textAlign={message.role === 'user' ? 'right' : 'left'}
                  >
                    {message.role === 'user' ? 'You' : 'Report assistant'}
                  </Box>
                  {message.role === 'assistant' ? (
                    <SpaceBetween size="s">
                      {message.content && <Markdown text={message.content} />}
                      {message.proposalIssue && (
                        <Alert type="warning">{message.proposalIssue}</Alert>
                      )}
                      {message.proposedEdit && (
                        <ProposalCard
                          edit={message.proposedEdit}
                          currentText={currentText}
                          canEdit={canEdit}
                          applied={applied.has(index)}
                          disabled={busy || props.busyElsewhere}
                          onApplyToEditor={() => props.onApplyToEditor(message.proposedEdit!)}
                          onSave={async () => {
                            const ok = await props.onSaveProposal(message.proposedEdit!);
                            if (ok) {
                              setApplied((current) => new Set(current).add(index));
                            }
                          }}
                        />
                      )}
                    </SpaceBetween>
                  ) : (
                    <Box variant="p">{message.content}</Box>
                  )}
                </div>
              </div>
            ))}
            {busy && <StatusIndicator type="loading">Thinking…</StatusIndicator>}
          </SpaceBetween>
        )}

        {chatError && (
          <Alert type="error" dismissible onDismiss={() => setChatError(null)}>
            {chatError}
          </Alert>
        )}

        <PromptInput
          value={draft}
          onChange={({ detail }) => setDraft(detail.value)}
          onAction={() => void send()}
          disabled={busy}
          actionButtonAriaLabel="Send"
          actionButtonIconName="send"
          placeholder={
            canEdit
              ? 'Ask a question or request a change to a section'
              : 'Ask a question about this report'
          }
          maxRows={6}
        />
      </SpaceBetween>
    </Container>
  );
}

interface ProposalCardProps {
  edit: ProposedEdit;
  currentText: string | null;
  canEdit: boolean;
  applied: boolean;
  disabled: boolean;
  onApplyToEditor: () => void;
  onSave: () => Promise<void>;
}

/** Side-by-side current vs proposed section, with review/save actions. */
function ProposalCard(props: ProposalCardProps) {
  const { edit, currentText } = props;
  const [saving, setSaving] = useState(false);
  const current = useMemo(() => {
    if (!currentText) return null;
    const section = findReportSection(currentText, edit.heading);
    return section ? extractReportSection(currentText, section) : null;
  }, [currentText, edit.heading]);
  const sectionTitle = edit.heading.replace(/^#+\s*/, '');

  return (
    <Container
      variant="stacked"
      header={
        <Header
          variant="h3"
          description={edit.rationale}
          actions={
            props.canEdit ? (
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  disabled={props.disabled || props.applied || saving}
                  onClick={props.onApplyToEditor}
                >
                  Apply to editor
                </Button>
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={props.disabled || props.applied}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await props.onSave();
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {props.applied ? 'Saved' : 'Save as new version'}
                </Button>
              </SpaceBetween>
            ) : (
              <Box color="text-body-secondary" fontSize="body-s">
                Only the workflow owner or an admin can save edits.
              </Box>
            )
          }
        >
          Proposed edit: {sectionTitle}
        </Header>
      }
    >
      <ColumnLayout columns={2} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Current</Box>
          {current === null ? (
            <Box color="text-body-secondary">
              {currentText ? 'Section not found in the version on screen.' : 'Loading…'}
            </Box>
          ) : (
            <Markdown text={current} />
          )}
        </div>
        <div>
          <Box variant="awsui-key-label">Proposed</Box>
          <Markdown text={edit.newMarkdown} />
        </div>
      </ColumnLayout>
    </Container>
  );
}
