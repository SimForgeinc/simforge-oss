/**
 * Lenient reader for esmini's `--csv_logger` output.
 *
 * `@simforge-oss/openscenario/esmini`'s `parseEsminiCsv` is a strict ingest
 * contract (fixed column count per row), which rejects files where an entity
 * is deleted mid-run: esmini then writes fewer entity groups on later rows.
 * Here every row is read group by group and each group identifies itself by
 * its Entity_Name, so deleted entities simply stop appearing.
 */

export interface EsminiCsvSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly speedMps: number;
  readonly headingRad: number;
}

function cells(line: string): string[] {
  return line.split(',').map((cell) => cell.trim());
}

function field(name: string): string {
  return name.replace(/^#\d+\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export function readEsminiCsv(csv: string): Map<string, EsminiCsvSample[]> {
  const lines = csv.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^Index\b/.test(line.trim()));
  if (headerIndex < 0) throw new Error('esmini CSV header not found');
  const header = cells(lines[headerIndex]!);
  const firstGroup = header.findIndex((cell) => /^#1\s/.test(cell));
  const secondGroup = header.findIndex((cell) => /^#2\s/.test(cell));
  const width = (secondGroup > 0 ? secondGroup : header.filter((cell) => cell !== '').length) - firstGroup;
  const offsets = new Map(header.slice(firstGroup, firstGroup + width).map((cell, index) => [field(cell), index]));
  const need = ['entity_name', 'current_speed', 'world_position_x', 'world_position_y', 'world_heading_angle'];
  for (const name of need) if (!offsets.has(name)) throw new Error(`esmini CSV lacks ${name}`);
  const out = new Map<string, EsminiCsvSample[]>();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const row = cells(line);
    const t = Number(row[1]);
    if (!Number.isFinite(t)) continue;
    for (let start = firstGroup; start + width <= row.length + 1; start += width) {
      const name = row[start + offsets.get('entity_name')!];
      if (!name) break;
      const at = (key: string) => Number(row[start + offsets.get(key)!]);
      const sample = { t, x: at('world_position_x'), y: at('world_position_y'), speedMps: at('current_speed'), headingRad: at('world_heading_angle') };
      if (![sample.x, sample.y, sample.speedMps, sample.headingRad].every(Number.isFinite)) continue;
      const list = out.get(name) ?? [];
      list.push(sample);
      out.set(name, list);
    }
  }
  return out;
}
