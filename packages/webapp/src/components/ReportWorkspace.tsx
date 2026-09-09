/**
 * ReportWorkspace — the report viewer with version history and a Markdown
 * editor as page content, plus the "Ask the report" chat mounted in the
 * AppLayout tools drawer so it stays alongside the report while you scroll.
 *
 * Reviewing an edit proposal happens IN the report, not in the drawer: the
 * drawer shows a compact card (section, rationale, change summary) with
 * Review / Save; Review scrolls to the section and swaps it into review mode
 * — a pinned action bar (Accept / Edit / Dismiss, Diff / Proposed / Current)
 * over an inline block-level diff. The report pane has the width and the
 * context; the drawer never has to show a side-by-side.
 *
 * Editing model (section-scoped, human-in-the-loop):
 *   - Nothing is written until the user Accepts (save) or Edits (open the
 *     editor with the proposal applied, tweak, save). Manual edits use the
 *     same editor and save path.
 *   - Saves create report.v<n>.md; the generated original is never
 *     overwritten. `baseVersion` gives optimistic concurrency (409 → reload).
 *   - Editing is offered to the workflow owner or an org admin (mirrors the
 *     API's owner-or-admin rule; the server enforces it regardless).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import {
  extractReportSection,
  findReportSection,
  listReportSections,
  replaceReportSection,
  type ReportSection,
} from '@agentic-platform/plan-schema';
import {
  api,
  ApiError,
  chatAboutReportStream,
  type ChatMessage,
  type ProposedEdit,
  type ReportVersion,
} from '../api';
import { formatDateTime } from '../format';
import {
  composeFromHunks,
  describeDiff,
  diffMarkdown,
  groupHunks,
  joinBlocks,
  summarizeDiff,
  wordDiffMarkdown,
  type Hunk,
} from '../reportDiff';
import { useShell } from '../shell/AppShell';
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

/** A proposal under review in the report pane. */
interface Review {
  edit: ProposedEdit;
  /** Index of the chat message that carried it (to mark it applied). */
  messageIndex: number;
  view: 'diff' | 'proposed' | 'current';
}

export default function ReportWorkspace(props: ReportWorkspaceProps) {
  const { runId, canEdit } = props;
  const shell = useShell();

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

  // Chat (state lives here so the drawer panel is pure props and survives
  // the drawer element being re-set on every render).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [answeredVersion, setAnsweredVersion] = useState<number | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [streaming, setStreaming] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  // Proposal review (in the report pane)
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

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
    setReview(null);
    setEditing(true);
  }

  const save = useCallback(
    async (markdown: string, changeNote?: string) => {
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
        setReview(null);
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
    },
    [runId, latest.version, props],
  );

  function spliced(edit: ProposedEdit): string | null {
    if (!loaded) return null;
    const result = replaceReportSection(loaded.text, edit.heading, edit.newMarkdown);
    if (!result.ok) {
      setSaveError(`Couldn't apply the proposal: ${result.error}`);
      return null;
    }
    return result.markdown;
  }

  /** Open the editor with the proposal applied to the latest text. */
  function editProposal(edit: ProposedEdit) {
    const markdown = spliced(edit);
    if (markdown === null) return;
    setSelectedVersion(latest.version);
    startEditing(markdown);
    setNote(edit.rationale ?? `Revised ${sectionTitle(edit.heading)}`);
  }

  /** One-click: splice and save the proposal as a new version. */
  async function acceptProposal(edit: ProposedEdit, messageIndex: number, noteSuffix?: string) {
    const markdown = spliced(edit);
    if (markdown === null) return false;
    const base = edit.rationale ?? `Revised ${sectionTitle(edit.heading)}`;
    const ok = await save(markdown, noteSuffix ? `${base} (${noteSuffix})` : base);
    if (ok) {
      setApplied((current) => new Set(current).add(messageIndex));
    }
    return ok;
  }

  /** Put a proposal into review mode in the report and scroll to it. */
  function reviewProposal(edit: ProposedEdit, messageIndex: number) {
    setSelectedVersion(latest.version);
    setEditing(false);
    setReview({ edit, messageIndex, view: 'diff' });
    // Scroll after the section re-renders in review mode.
    window.setTimeout(
      () => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }

  /** "Ask about this section": seed the prompt and open the drawer. */
  function askAboutSection(heading: string) {
    setChatDraft(`About "${sectionTitle(heading)}": `);
    shell.openTools();
  }

  const sendChat = useCallback(async () => {
    const question = chatDraft.trim();
    if (!question || chatBusy) {
      return;
    }
    const history: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(history);
    setChatDraft('');
    setChatError(null);
    setStreaming('');
    setDrafting(false);
    setChatBusy(true);
    try {
      const { message, reportVersion } = await chatAboutReportStream(runId, history, {
        onDelta: (text) => setStreaming((current) => (current ?? '') + text),
        onStatus: (phase) => {
          if (phase === 'drafting-edit') setDrafting(true);
        },
      });
      setStreaming(null);
      setDrafting(false);
      setMessages((current) => [...current, message]);
      setAnsweredVersion(reportVersion);
      // A fresh proposal goes straight into review so the user sees it in
      // context without an extra click; the drawer card keeps the summary.
      if (message.proposedEdit && loaded) {
        reviewProposal(message.proposedEdit, history.length);
      }
    } catch (e) {
      setStreaming(null);
      setDrafting(false);
      if (e instanceof ApiError && e.status === 409) {
        setChatError('The report for this run isn’t available yet.');
      } else if (e instanceof ApiError && e.status === 503) {
        setChatError('Report chat isn’t enabled for this deployment.');
      } else {
        setChatError(e instanceof Error ? e.message : 'chat failed');
      }
    } finally {
      setChatBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatDraft, chatBusy, messages, runId, loaded]);

  // Mount the chat in the tools drawer; clear it when this page goes away.
  useEffect(() => {
    shell.setTools(
      <ChatPanel
        canEdit={canEdit}
        messages={messages}
        draft={chatDraft}
        busy={chatBusy || saving}
        error={chatError}
        streaming={streaming}
        drafting={drafting}
        stale={answeredVersion !== null && answeredVersion !== latest.version}
        latestVersion={latest.version}
        currentText={loaded?.text ?? null}
        applied={applied}
        reviewing={review?.messageIndex ?? null}
        onDraftChange={setChatDraft}
        onSend={() => void sendChat()}
        onClear={() => {
          setMessages([]);
          setChatError(null);
          setApplied(new Set());
          setReview(null);
        }}
        onDismissError={() => setChatError(null)}
        onReview={reviewProposal}
        onAccept={acceptProposal}
      />,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canEdit,
    messages,
    chatDraft,
    chatBusy,
    saving,
    chatError,
    streaming,
    drafting,
    answeredVersion,
    latest.version,
    loaded,
    applied,
    review,
    sendChat,
  ]);
  useEffect(() => () => shell.setTools(null), [shell]);

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
                  onChange={({ detail }) => setSelectedVersion(Number(detail.selectedOption.value))}
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
              <Button iconName="contact" onClick={() => shell.openTools()}>
                Ask the report
              </Button>
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

        {loaded && !editing && (
          <ReportBody
            text={loaded.text}
            review={viewingLatest ? review : null}
            reviewRef={reviewRef}
            canEdit={canEdit}
            saving={saving}
            onAsk={askAboutSection}
            onViewChange={(view) => setReview((r) => (r ? { ...r, view } : r))}
            onAccept={(section, acceptedCount, total) =>
              review &&
              void acceptProposal(
                { ...review.edit, newMarkdown: section },
                review.messageIndex,
                acceptedCount === total ? undefined : `${acceptedCount} of ${total} proposed changes`,
              )
            }
            onEdit={(section) => review && editProposal({ ...review.edit, newMarkdown: section })}
            onDismiss={() => setReview(null)}
          />
        )}

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
  );
}

function sectionTitle(heading: string): string {
  return heading.replace(/^#+\s*/, '').trim();
}

function downloadMarkdown(report: LoadedReport) {
  const blob = new Blob([report.text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = report.version === 1 ? 'report.md' : `report.v${report.version}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Report body: heading-chunked sections, hover "Ask", in-place review ──

interface ReportBodyProps {
  text: string;
  review: Review | null;
  reviewRef: React.RefObject<HTMLDivElement>;
  canEdit: boolean;
  saving: boolean;
  onAsk: (heading: string) => void;
  onViewChange: (view: Review['view']) => void;
  onAccept: (sectionMarkdown: string, acceptedCount: number, total: number) => void;
  onEdit: (sectionMarkdown: string) => void;
  onDismiss: () => void;
}

/**
 * Renders the report as a sequence of chunks split at every heading. The
 * chunk that owns the proposal's section (heading through the next heading
 * of the same or higher level — possibly spanning several chunks) is
 * replaced by the review block; everything else renders normally, so the
 * change is seen in context.
 */
function ReportBody(props: ReportBodyProps) {
  const { text, review } = props;
  const lines = useMemo(() => text.split('\n'), [text]);
  const sections = useMemo(() => listReportSections(text), [text]);

  // The reviewed section's line range in the current text (if it applies).
  const target: ReportSection | undefined = useMemo(
    () => (review ? findReportSection(text, review.edit.heading) : undefined),
    [text, review],
  );

  // Chunks: [0, firstHeading) preamble, then one chunk per heading up to the
  // next heading of ANY level. The review block swallows every chunk inside
  // the target range.
  const chunks = useMemo(() => {
    const starts = sections.map((s) => s.startLine);
    const out: Array<{ start: number; end: number; heading?: string }> = [];
    if (starts.length === 0 || starts[0]! > 0) {
      out.push({ start: 0, end: starts[0] ?? lines.length });
    }
    for (let i = 0; i < starts.length; i++) {
      out.push({
        start: starts[i]!,
        end: starts[i + 1] ?? lines.length,
        heading: sections[i]!.heading,
      });
    }
    return out;
  }, [sections, lines.length]);

  const rendered: React.ReactNode[] = [];
  let reviewEmitted = false;
  for (const chunk of chunks) {
    if (target && chunk.start >= target.startLine && chunk.start < target.endLine) {
      if (!reviewEmitted) {
        reviewEmitted = true;
        rendered.push(
          <div key={`review-${target.startLine}`} ref={props.reviewRef}>
            <ReviewBlock
              current={extractReportSection(text, target)}
              proposed={review!.edit.newMarkdown}
              rationale={review!.edit.rationale}
              view={review!.view}
              canEdit={props.canEdit}
              saving={props.saving}
              onViewChange={props.onViewChange}
              onAccept={props.onAccept}
              onEdit={props.onEdit}
              onDismiss={props.onDismiss}
            />
          </div>,
        );
      }
      continue;
    }
    const chunkText = lines.slice(chunk.start, chunk.end).join('\n');
    rendered.push(
      <SectionChunk
        key={`${chunk.start}`}
        text={chunkText}
        heading={chunk.heading}
        onAsk={props.onAsk}
      />,
    );
  }
  if (review && !target) {
    rendered.unshift(
      <Alert key="review-missing" type="warning" dismissible onDismiss={props.onDismiss}>
        The proposed section “{sectionTitle(review.edit.heading)}” isn’t in this version of the
        report.
      </Alert>,
    );
  }
  return <div className="report-body">{rendered}</div>;
}

/** One heading-led chunk with a hover "Ask about this section" affordance. */
function SectionChunk(props: { text: string; heading?: string; onAsk: (heading: string) => void }) {
  return (
    <div className="report-section">
      {props.heading && (
        <div className="report-section-ask">
          <Button
            variant="inline-icon"
            iconName="contact"
            ariaLabel={`Ask about ${sectionTitle(props.heading)}`}
            onClick={() => props.onAsk(props.heading!)}
          />
        </div>
      )}
      <Markdown text={props.text} />
    </div>
  );
}

interface ReviewBlockProps {
  current: string;
  proposed: string;
  rationale?: string;
  view: Review['view'];
  canEdit: boolean;
  saving: boolean;
  onViewChange: (view: Review['view']) => void;
  /** Save the section as composed from the accepted hunks. */
  onAccept: (sectionMarkdown: string, acceptedCount: number, total: number) => void;
  /** Open the editor with the section as composed from the accepted hunks. */
  onEdit: (sectionMarkdown: string) => void;
  onDismiss: () => void;
}

/**
 * The section under review. Changes are grouped into hunks, each with its
 * own Accept / Keep current toggle (all accepted by default); the sticky bar
 * saves whatever subset is accepted. Paired paragraphs show word-level
 * highlights so a reworded sentence reads as an edit, not a replacement.
 */
function ReviewBlock(props: ReviewBlockProps) {
  const hunks = useMemo(
    () => groupHunks(diffMarkdown(props.current, props.proposed)),
    [props.current, props.proposed],
  );
  const changeHunks = useMemo(() => hunks.filter((h) => h.kind === 'change'), [hunks]);
  const [accepted, setAccepted] = useState<boolean[]>(() => changeHunks.map(() => true));
  // Reset decisions when a different proposal comes under review.
  useEffect(() => {
    setAccepted(changeHunks.map(() => true));
  }, [changeHunks]);
  const acceptedCount = accepted.filter(Boolean).length;
  const composed = useMemo(() => composeFromHunks(hunks, accepted), [hunks, accepted]);
  const summary = useMemo(
    () => describeDiff(summarizeDiff(diffMarkdown(props.current, props.proposed))),
    [props.current, props.proposed],
  );
  const setAll = (value: boolean) => setAccepted(changeHunks.map(() => value));

  return (
    <div className="report-review">
      <div className="report-review-bar">
        <SpaceBetween direction="horizontal" size="s" alignItems="center">
          <Box variant="strong">Proposed edit</Box>
          <Box color="text-body-secondary" fontSize="body-s">
            {summary}
          </Box>
          <SegmentedControl
            selectedId={props.view}
            onChange={({ detail }) => props.onViewChange(detail.selectedId as Review['view'])}
            options={[
              { id: 'diff', text: 'Diff' },
              { id: 'proposed', text: 'Proposed' },
              { id: 'current', text: 'Current' },
            ]}
          />
          <SpaceBetween direction="horizontal" size="xs">
            {props.canEdit && (
              <>
                <Button
                  variant="primary"
                  loading={props.saving}
                  disabled={acceptedCount === 0}
                  disabledReason="No changes accepted — accept at least one, or dismiss."
                  onClick={() => props.onAccept(composed, acceptedCount, changeHunks.length)}
                >
                  {acceptedCount === changeHunks.length
                    ? 'Save all changes'
                    : `Save ${acceptedCount} of ${changeHunks.length}`}
                </Button>
                <Button disabled={props.saving} onClick={() => props.onEdit(composed)}>
                  Edit
                </Button>
              </>
            )}
            <Button disabled={props.saving} onClick={props.onDismiss}>
              Dismiss
            </Button>
          </SpaceBetween>
        </SpaceBetween>
        <SpaceBetween direction="horizontal" size="s" alignItems="center">
          {props.rationale && (
            <Box color="text-body-secondary" fontSize="body-s">
              {props.rationale}
            </Box>
          )}
          {props.view === 'diff' && changeHunks.length > 1 && (
            <SpaceBetween direction="horizontal" size="xxs">
              <Button variant="inline-link" onClick={() => setAll(true)}>
                Accept all
              </Button>
              <Box color="text-body-secondary">·</Box>
              <Button variant="inline-link" onClick={() => setAll(false)}>
                Keep all current
              </Button>
            </SpaceBetween>
          )}
        </SpaceBetween>
        {!props.canEdit && (
          <Box color="text-body-secondary" fontSize="body-s" padding={{ top: 'xxs' }}>
            Only the workflow owner or an admin can save edits.
          </Box>
        )}
      </div>
      {props.view === 'diff' && (
        <HunkDiff
          hunks={hunks}
          accepted={accepted}
          canEdit={props.canEdit}
          onToggle={(index, value) =>
            setAccepted((current) => current.map((v, i) => (i === index ? value : v)))
          }
        />
      )}
      {props.view === 'proposed' && (
        <div className="report-review-pane">
          <Markdown text={composed} />
        </div>
      )}
      {props.view === 'current' && (
        <div className="report-review-pane">
          <Markdown text={props.current} />
        </div>
      )}
    </div>
  );
}

interface HunkDiffProps {
  hunks: Hunk[];
  accepted: boolean[];
  canEdit: boolean;
  onToggle: (changeIndex: number, accepted: boolean) => void;
}

/**
 * Hunk-by-hunk inline diff. Within a change hunk, removed and added blocks
 * are paired positionally; a pair that reads as one edited paragraph renders
 * merged with <del>/<ins> word highlights, otherwise stacked. Every block is
 * still rendered Markdown.
 */
function HunkDiff({ hunks, accepted, canEdit, onToggle }: HunkDiffProps) {
  let changeIndex = -1;
  return (
    <div className="report-diff">
      {hunks.map((hunk, hunkIndex) => {
        if (hunk.kind === 'equal') {
          return (
            <div key={hunkIndex} className="report-diff-block report-diff-equal">
              <Markdown text={joinBlocks(hunk.blocks)} />
            </div>
          );
        }
        changeIndex++;
        const index = changeIndex;
        const isAccepted = accepted[index] ?? true;
        const pairs = Math.max(hunk.removed.length, hunk.added.length);
        const rows: React.ReactNode[] = [];
        for (let p = 0; p < pairs; p++) {
          const before = hunk.removed[p];
          const after = hunk.added[p];
          const merged = before && after ? wordDiffMarkdown(before, after) : null;
          if (merged !== null) {
            rows.push(
              <div key={`m${p}`} className="report-diff-block report-diff-merged">
                <Markdown text={merged} />
              </div>,
            );
            continue;
          }
          if (before) {
            rows.push(
              <div key={`r${p}`} className="report-diff-block report-diff-removed">
                <Markdown text={before} />
              </div>,
            );
          }
          if (after) {
            rows.push(
              <div key={`a${p}`} className="report-diff-block report-diff-added">
                <Markdown text={after} />
              </div>,
            );
          }
        }
        return (
          <div
            key={hunkIndex}
            className={`report-diff-hunk${isAccepted ? ' report-diff-hunk-accepted' : ' report-diff-hunk-rejected'}`}
          >
            <div className="report-diff-hunk-bar">
              <Box fontSize="body-s" color="text-body-secondary">
                Change {index + 1}
                {!isAccepted && ' — keeping current text'}
              </Box>
              {canEdit && (
                <SegmentedControl
                  selectedId={isAccepted ? 'accept' : 'keep'}
                  onChange={({ detail }) => onToggle(index, detail.selectedId === 'accept')}
                  options={[
                    { id: 'accept', text: 'Accept', iconName: 'check' },
                    { id: 'keep', text: 'Keep current', iconName: 'undo' },
                  ]}
                />
              )}
            </div>
            {rows}
          </div>
        );
      })}
    </div>
  );
}

// ── Drawer panel: the chat ───────────────────────────────────────────────

interface ChatPanelProps {
  canEdit: boolean;
  messages: ChatMessage[];
  draft: string;
  busy: boolean;
  error: string | null;
  /** In-flight assistant text ('' = waiting; null = idle). */
  streaming: string | null;
  drafting: boolean;
  stale: boolean;
  latestVersion: number;
  currentText: string | null;
  applied: Set<number>;
  reviewing: number | null;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClear: () => void;
  onDismissError: () => void;
  onReview: (edit: ProposedEdit, messageIndex: number) => void;
  onAccept: (edit: ProposedEdit, messageIndex: number) => Promise<boolean>;
}

function ChatPanel(props: ChatPanelProps) {
  const { messages, canEdit } = props;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, props.streaming]);

  return (
    <div className="chat-drawer">
      <div className="chat-drawer-header">
        <Header variant="h2">Ask the report</Header>
        <Box color="text-body-secondary" fontSize="body-s">
          {canEdit
            ? 'Answers are grounded in this report and its task outputs. Ask for a change and the assistant proposes a section edit you can review in the report.'
            : 'Answers are grounded in this report and its task outputs.'}
        </Box>
      </div>
      <div className="chat-drawer-body">
      <SpaceBetween size="m">
        {props.stale && (
          <Alert type="info">
            The report is now v{props.latestVersion}. New answers use the latest version.
          </Alert>
        )}
        {messages.length === 0 ? (
          <Box color="text-body-secondary">
            Try “Summarize the key findings”, “Where did the 12% figure come from?”
            {canEdit ? ', or “Rewrite the executive summary to lead with the risks”.' : '.'}
            <Box padding={{ top: 's' }} fontSize="body-s">
              Tip: hover a section heading in the report and use the chat button to ask about it.
            </Box>
          </Box>
        ) : (
          <SpaceBetween size="s">
            {messages.map((message, index) => (
              <div key={index} className={`chat-turn chat-turn-${message.role}`}>
                <Box fontSize="body-s" color="text-body-secondary">
                  {message.role === 'user' ? 'You' : 'Report assistant'}
                </Box>
                {message.role === 'assistant' ? (
                  <SpaceBetween size="xs">
                    {message.content && <Markdown text={message.content} />}
                    {message.proposalIssue && <Alert type="warning">{message.proposalIssue}</Alert>}
                    {message.proposedEdit && (
                      <ProposalSummary
                        edit={message.proposedEdit}
                        currentText={props.currentText}
                        canEdit={canEdit}
                        applied={props.applied.has(index)}
                        reviewing={props.reviewing === index}
                        disabled={props.busy}
                        onReview={() => props.onReview(message.proposedEdit!, index)}
                        onAccept={() => props.onAccept(message.proposedEdit!, index)}
                      />
                    )}
                  </SpaceBetween>
                ) : (
                  <Box variant="p">{message.content}</Box>
                )}
              </div>
            ))}
            {props.busy && props.streaming !== null && (
              <div className="chat-turn chat-turn-assistant">
                <Box fontSize="body-s" color="text-body-secondary">
                  Report assistant
                </Box>
                {props.streaming ? (
                  <SpaceBetween size="xs">
                    <Markdown text={props.streaming} />
                    {props.drafting && (
                      <StatusIndicator type="loading">Drafting a section edit…</StatusIndicator>
                    )}
                  </SpaceBetween>
                ) : (
                  <StatusIndicator type="loading">
                    {props.drafting ? 'Drafting a section edit…' : 'Thinking…'}
                  </StatusIndicator>
                )}
              </div>
            )}
            <div ref={bottomRef} />
            <Box textAlign="right">
              <Button variant="inline-link" disabled={props.busy} onClick={props.onClear}>
                Clear conversation
              </Button>
            </Box>
          </SpaceBetween>
        )}
      </SpaceBetween>
      </div>
      {/* Composer pinned to the bottom of the drawer's scroll area. */}
      <div className="chat-drawer-composer">
        <SpaceBetween size="xs">
          {props.error && (
            <Alert type="error" dismissible onDismiss={props.onDismissError}>
              {props.error}
            </Alert>
          )}
          <PromptInput
            value={props.draft}
            onChange={({ detail }) => props.onDraftChange(detail.value)}
            onAction={props.onSend}
            disabled={props.busy}
            actionButtonAriaLabel="Send"
            actionButtonIconName="send"
            placeholder={
              canEdit ? 'Ask a question or request a change' : 'Ask a question about this report'
            }
            maxRows={5}
          />
        </SpaceBetween>
      </div>
    </div>
  );
}

interface ProposalSummaryProps {
  edit: ProposedEdit;
  currentText: string | null;
  canEdit: boolean;
  applied: boolean;
  reviewing: boolean;
  disabled: boolean;
  onReview: () => void;
  onAccept: () => Promise<boolean>;
}

/** Compact drawer card: what changed and how much; review happens in the report. */
function ProposalSummary(props: ProposalSummaryProps) {
  const { edit, currentText } = props;
  const [saving, setSaving] = useState(false);
  const summary = useMemo(() => {
    if (!currentText) return null;
    const section = findReportSection(currentText, edit.heading);
    if (!section) return 'section not found in the current version';
    return describeDiff(summarizeDiff(diffMarkdown(extractReportSection(currentText, section), edit.newMarkdown)));
  }, [currentText, edit]);
  return (
    <div className={`chat-proposal${props.reviewing ? ' chat-proposal-active' : ''}`}>
      <SpaceBetween size="xs">
        <Box variant="strong">Proposed edit: {sectionTitle(edit.heading)}</Box>
        {summary && (
          <Box color="text-body-secondary" fontSize="body-s">
            {summary}
          </Box>
        )}
        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant={props.canEdit ? 'normal' : 'primary'}
            disabled={props.applied}
            onClick={props.onReview}
          >
            {props.reviewing ? 'Reviewing…' : 'Review in report'}
          </Button>
          {props.canEdit && (
            <Button
              variant="primary"
              loading={saving}
              disabled={props.disabled || props.applied}
              onClick={async () => {
                setSaving(true);
                try {
                  await props.onAccept();
                } finally {
                  setSaving(false);
                }
              }}
            >
              {props.applied ? 'Saved' : 'Save'}
            </Button>
          )}
        </SpaceBetween>
      </SpaceBetween>
    </div>
  );
}
