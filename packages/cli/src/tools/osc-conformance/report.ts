import type { CaseResult, EventComparison } from './run.js';

export interface ConformanceReport {
  readonly schema: string;
  readonly esmini: { readonly version: string; readonly sha256: string } | null;
  readonly results: readonly CaseResult[];
}

const n = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined ? '—' : value.toFixed(digits);

function worst(result: CaseResult, side: 'ours' | 'esmini', field: 'position' | 'speed'): string {
  const actors = result[side].actors;
  return actors.length ? n(Math.max(...actors.map((actor) => actor[field].max)), 3) : '—';
}

function eventRow(event: EventComparison): string {
  const oracle = event.oracle ? `${n(event.oracle.start)} → ${event.oracle.end === undefined ? '·' : n(event.oracle.end)}` : '—';
  const ours = event.ours ? `${n(event.ours.start)} → ${n(event.ours.end)}${event.ours.endKind ? ` (${event.ours.endKind})` : ''}` : '—';
  const esmini = event.esmini ? `${n(event.esmini.start)} → ${n(event.esmini.end)}${event.esmini.endKind ? ` (${event.esmini.endKind})` : ''}` : '—';
  return `| ${event.interactionId} | ${oracle} | ${ours} | ${esmini} |`;
}

/** Markdown summary: one row per case, then per-case detail. */
export function formatReport(report: ConformanceReport): string {
  const lines = [
    `# OpenSCENARIO conformance report`,
    '',
    `Reference: spec-derived oracle (ASAM OpenSCENARIO XML 1.4.0). esmini: ${report.esmini ? `${report.esmini.version} (sha256 ${report.esmini.sha256.slice(0, 12)}…), secondary evidence only` : 'not installed'}.`,
    '',
    '| Case | Feature | Ours vs spec | Recorded | esmini vs spec | Round trip | Ours max pos / speed err | esmini max pos / speed err |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const result of report.results) {
    const recorded = result.expected.finding ? `${result.expected.ours} (${result.expected.finding})` : result.expected.ours;
    lines.push(`| ${result.id}${result.unexpected.length ? ' ⚠' : ''} | ${result.feature} | ${result.ours.verdict} | ${recorded} | ${result.esmini.verdict} | ${result.roundTrip.verdict} | ${worst(result, 'ours', 'position')} m / ${worst(result, 'ours', 'speed')} m/s | ${worst(result, 'esmini', 'position')} m / ${worst(result, 'esmini', 'speed')} m/s |`);
  }
  for (const result of report.results) {
    lines.push('', `## ${result.id}`, '', `${result.feature}. Clauses: ${result.clauses.join('; ')}.${result.decisions.length ? ` Decisions: ${result.decisions.join(', ')}.` : ''}`, '');
    if (result.unexpected.length) lines.push(...result.unexpected.map((reason) => `- **UNEXPECTED:** ${reason}`), '');
    if (result.events.length) {
      lines.push('| Event | spec start → end (s) | ours | esmini |', '|---|---|---|---|', ...result.events.map(eventRow), '');
    }
    for (const side of ['ours', 'esmini'] as const) {
      for (const actor of result[side].actors) {
        lines.push(`- ${side} ${actor.actorId}: pos max ${n(actor.position.max, 3)} m @ ${n(actor.position.atT)} s; speed max ${n(actor.speed.max, 3)} m/s @ ${n(actor.speed.atT)} s; heading max ${n(actor.headingDeg.max, 2)}°; final (${n(actor.subject.x)}, ${n(actor.subject.y)}, ${n(actor.subject.speedMps)} m/s) vs spec (${n(actor.reference.x)}, ${n(actor.reference.y)}, ${n(actor.reference.speedMps)} m/s)`);
      }
      for (const reason of result[side].reasons) lines.push(`- ${side}: ${reason}`);
    }
    for (const reason of result.roundTrip.reasons) lines.push(`- round trip: ${reason}`);
    for (const diagnostic of result.esmini.diagnostics) lines.push(`- esmini log: \`${diagnostic}\``);
  }
  return `${lines.join('\n')}\n`;
}
