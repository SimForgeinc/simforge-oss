import { normalizeGallery, normalizeJob } from './model';
import type {
  Artifact, CampaignBenchmark, CampaignCase, CampaignCaseProgress, CampaignCaseState, CampaignReport,
  CampaignTotals, CampaignVideo, GalleryCard, HourlyRate, JobIndex, RawJobIndex, StageEvent, SubmitPayload,
} from './types';

const token = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('token');

export function withToken(path: string): string {
  if (!token) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set('token', token);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withToken(path), init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export async function getGallery(): Promise<GalleryCard[]> {
  const result = await json<GalleryCard[] | { cards?: GalleryCard[]; gallery?: GalleryCard[] }>('/api/gallery');
  return normalizeGallery(Array.isArray(result) ? result : result.cards ?? result.gallery ?? []);
}

export const getJob = async (id: string) => normalizeJob(await json<JobIndex | RawJobIndex>(`/api/jobs/${encodeURIComponent(id)}/full`));

export async function submitJob(payload: SubmitPayload): Promise<string> {
  const result = await json<{ jobId: string }>('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!result.jobId) throw new Error('Server response did not include jobId');
  return result.jobId;
}

export function subscribe(id: string, onStage: (event: StageEvent) => void, onConnection: (live: boolean) => void): () => void {
  const source = new EventSource(withToken(`/api/jobs/${encodeURIComponent(id)}`));
  source.onopen = () => onConnection(true);
  source.onmessage = (message) => {
    try { onStage(JSON.parse(message.data) as StageEvent); } catch { /* ignore keepalive text */ }
  };
  source.addEventListener('stage', (message) => {
    try { onStage(JSON.parse((message as MessageEvent).data) as StageEvent); } catch { /* malformed event */ }
  });
  source.onerror = () => onConnection(false);
  return () => source.close();
}

export function artifactUrl(artifact: Artifact | string): string {
  const raw = typeof artifact === 'string' ? artifact : artifact.url ?? artifact.path ?? '';
  if (/^(data:|blob:|https?:\/\/)/.test(raw)) return raw;
  if (raw.startsWith('/artifacts/')) return withToken(raw);
  return withToken(`/artifacts/${raw.replace(/^\/+/, '')}`);
}

export const CAMPAIGN_ID = 'edge-cases-67x5';

const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/**
 * Normalise a per-hour rate. Reports written before rates carried their window
 * published a bare number; that number is preserved but its denominator is
 * recorded as unknown, so the UI can say so instead of implying a measured
 * observation window it never had.
 */
function hourly(value: unknown, numerator: number): HourlyRate {
  if (value !== null && typeof value === 'object' && 'value' in (value as object)) {
    const rate = value as HourlyRate;
    return {
      numerator: count(rate.numerator),
      denominatorHours: rate.denominatorHours ?? null,
      value: rate.value ?? null,
    };
  }
  if (Number.isFinite(Number(value))) return { numerator, denominatorHours: null, value: Number(value) };
  return { numerator, denominatorHours: null, value: null };
}
/** Strict campaign validity: only unique, hashed, published 3D videos may ever be presented as a result. */
function acceptedVideos(raw: CampaignVideo[] | undefined): CampaignVideo[] {
  const seen = new Set<string>();
  return (raw ?? []).filter((video) => {
    if (!video?.url || !video.sha256 || seen.has(video.sha256)) return false;
    seen.add(video.sha256);
    return true;
  });
}

export function normalizeCampaign(raw: Partial<CampaignReport>): CampaignReport {
  const target = count(raw.targetValidVideos ?? raw.validityContract?.minimumPerCase);
  const cases: CampaignCase[] = (raw.cases ?? []).map((item, index) => ({
    ...item,
    id: item.id ?? `case-${index + 1}`,
    title: item.title ?? item.id ?? `Case ${index + 1}`,
    index: Number.isFinite(item.index) ? item.index : index,
    // Absent means the runner never published one. Defaulting it to a real
    // outcome would override the status-derived fallback with a fabricated value.
    outcome: item.outcome ?? null,
    unsupported: item.unsupported ?? null,
    generationAttempts: count(item.generationAttempts),
    operationalFailures: count(item.operationalFailures),
    attempts: item.attempts ?? [],
    validVideos: acceptedVideos(item.validVideos),
  }));
  const validVideos = cases.reduce((sum, item) => sum + item.validVideos.length, 0);
  const totals: CampaignTotals = {
    ...raw.totals,
    cases: raw.totals?.cases ?? cases.length,
    completeCases: cases.filter((item) => target > 0 && item.validVideos.length >= target).length,
    targetVideos: count(raw.totals?.targetVideos) || cases.length * target,
    validVideos,
    jobs: count(raw.totals?.jobs), activeJobs: count(raw.totals?.activeJobs), failedJobs: count(raw.totals?.failedJobs),
    wallS: count(raw.totals?.wallS), stageSeconds: raw.totals?.stageSeconds ?? {},
    tokens: {
      calls: count(raw.totals?.tokens?.calls), inputTokens: count(raw.totals?.tokens?.inputTokens),
      outputTokens: count(raw.totals?.tokens?.outputTokens), reasoningTokens: count(raw.totals?.tokens?.reasoningTokens),
      modelWallS: count(raw.totals?.tokens?.modelWallS),
    },
    elapsedHours: count(raw.totals?.elapsedHours),
    validVideosPerHour: hourly(raw.totals?.validVideosPerHour, validVideos),
    jobsPerHour: hourly(raw.totals?.jobsPerHour, count(raw.totals?.jobs)),
    minimumObservationHours: raw.totals?.minimumObservationHours,
    meanTokensPerValidVideo: raw.totals?.meanTokensPerValidVideo ?? null,
    benchmark: raw.totals?.benchmark,
  };
  return {
    ...raw,
    campaignId: raw.campaignId ?? CAMPAIGN_ID,
    targetValidVideos: target,
    updatedAt: raw.updatedAt ?? '',
    cases, totals,
    validityContract: raw.validityContract ?? {},
  };
}

/**
 * Per-case progress for display.
 *
 * `item.outcome` is the runner's authoritative classification of the case and is
 * preferred whenever it is published: it knows about the attempt budget and
 * deterministic unsupported reasons, which cannot be re-derived from attempt
 * statuses alone. The status-derived state remains the fallback for a report
 * written before outcomes existed.
 */
export function campaignCaseProgress(item: CampaignCase, target: number): CampaignCaseProgress {
  const accepted = item.validVideos.length;
  const active = item.attempts.filter((attempt) => attempt.status === 'queued' || attempt.status === 'running').length;
  const failed = item.attempts.filter((attempt) => attempt.status === 'failed').length;
  const latest = item.attempts.at(-1);
  const derived: CampaignCaseState = accepted >= target && target > 0 ? 'complete'
    : active > 0 ? 'running'
      : latest?.status === 'failed' ? 'blocked' : 'idle';
  const fromOutcome: Partial<Record<string, CampaignCaseState>> = {
    accepted: 'complete', attempting: active > 0 ? 'running' : 'blocked', exhausted: 'blocked',
    unsupported: 'unsupported', pending: 'idle',
  };
  const state = (item.outcome && fromOutcome[item.outcome]) ?? derived;
  return {
    state,
    outcome: item.outcome ?? null,
    unsupportedReason: item.unsupported?.reason ?? null,
    accepted,
    target,
    attempts: item.attempts.length,
    active,
    failed,
    latest,
  };
}

export async function getCampaign(id: string): Promise<CampaignReport> {
  const response = await fetch(withToken(`/api/campaigns/${encodeURIComponent(id)}`));
  if (response.status === 404) throw new Error(`No published report for campaign "${id}" yet. The runner writes report.json on its first publish cycle.`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return normalizeCampaign(await response.json() as Partial<CampaignReport>);
}

export async function getCampaignBenchmark(id: string): Promise<CampaignBenchmark> {
  const response = await fetch(withToken(`/api/campaigns/${encodeURIComponent(id)}/benchmark`));
  if (response.status === 404) throw new Error(`No published report for campaign "${id}" yet. The runner writes report.json on its first publish cycle.`);
  if (response.status === 409) throw new Error('campaign report predates the benchmark schema');
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<CampaignBenchmark>;
}
