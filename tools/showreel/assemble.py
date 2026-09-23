#!/usr/bin/env python3
"""Assemble a text-narrated evidence video from a JSON segment manifest.

Requires Python 3, Pillow, ffmpeg and ffprobe. All driving pixels come from the
listed source videos or recorded native PNGs; cards/panels visualize recorded data. Example:
  python3 tools/showreel/assemble.py /path/to/manifest.json --out /path/to/SHOWREEL

Kinds: card (bullets), video (source, optional run_dir/closed_loop_only/speed/native_frames),
image (source), table (reports and/or runs). Every segment has id, chapter,
title, description; optional subtitle, notes, links, duration_s. Paths resolve
relative to the manifest. Output is 1920x1080 H.264, 30 fps, without audio.
"""
import argparse
import csv
import datetime as dt
import fcntl
import hashlib
import html
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont, ImageOps

WIDTH, HEIGHT, FPS = 1920, 1080, 30
BG, PANEL, FG, MUTED, ACCENT = '#0c1524', '#14253a', '#edf3fa', '#afc2d7', '#63decf'
FONT_ROOT = Path('/usr/share/fonts/truetype/dejavu')


def load(path):
    return json.loads(Path(path).read_text())


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def font(size, bold=False, mono=False):
    name = 'DejaVuSansMono' if mono else 'DejaVuSans'
    return ImageFont.truetype(str(FONT_ROOT / f'{name}{"-Bold" if bold else ""}.ttf'), size)


def lines_for(text, face, width):
    """Pixel-width wrapping, including exact artifact paths with no spaces."""
    lines = []
    for paragraph in str(text).split('\n'):
        current = ''
        for word in paragraph.split(' '):
            candidate = f'{current} {word}'.strip()
            if face.getlength(candidate) <= width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ''
            while face.getlength(word) > width:
                cut = 1
                while cut < len(word) and face.getlength(word[:cut + 1]) <= width:
                    cut += 1
                lines.append(word[:cut])
                word = word[cut:]
            current = word
        lines.append(current)
    return lines


def text_block(draw, text, xy, width, *, size=34, fill=FG, bold=False,
               max_height=None, minimum=24, gap=1.3):
    while True:
        face = font(size, bold)
        lines = lines_for(text, face, width)
        leading = math.ceil(size * gap)
        if max_height is None or len(lines) * leading <= max_height:
            break
        size -= 1
        if size < minimum:
            raise ValueError(f'Text does not fit at {minimum}px: {text!r}')
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=face, fill=fill)
        y += leading
    return y


def canvas(segment):
    image = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 16, HEIGHT), fill=ACCENT)
    text_block(draw, segment.get('chapter', 'SIMFORGE').upper(), (54, 26), 1800,
               size=23, fill=ACCENT, bold=True, max_height=32)
    text_block(draw, segment['title'], (54, 66), 1800, size=51, bold=True,
               max_height=68, minimum=30)
    if segment.get('subtitle'):
        text_block(draw, segment['subtitle'], (56, 140), 1800, size=27,
                   fill=MUTED, max_height=39, minimum=22)
    draw.line((56, 188, 1864, 188), fill='#2b4058', width=2)
    return image


def card(segment, dest):
    image = canvas(segment)
    draw = ImageDraw.Draw(image)
    bullets = segment.get('bullets', [])
    text = '\n\n'.join(str(item) for item in bullets)
    text_block(draw, text, (78, 229), 1740, size=40, max_height=741, minimum=26)
    image.save(dest)


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate',
                             '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    stream = next(s for s in data['streams'] if s['codec_type'] == 'video')
    return {'duration': float(data['format']['duration']), **stream}


def encode(args, output, duration):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
           '-filter_complex_threads', '2', *args, '-an', '-t', str(duration),
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '4',
           '-r', str(FPS), '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360',
           '-movflags', '+faststart', str(output)]
    subprocess.run(cmd, check=True)


def fmt(value, digits=3):
    return 'n/a' if value is None else f'{value:.{digits}f}'


def collision_count(score):
    values = [score.get('infractions', {}).get(kind) for kind in
              ('collision-vehicle', 'collision-pedestrian', 'collision-static')]
    return sum(values) if all(isinstance(value, (int, float)) for value in values) else None


def metrics_rows(segment):
    rows = []
    for path in segment.get('reports', []):
        report = load(path)
        for item in report['runs']:
            run_dir = Path(item['runDir'])
            if not run_dir.is_absolute():
                run_dir = Path(path).parent / run_dir
            run = load(run_dir / 'run.json')
            score = item['score']
            rows.append({'policy': item['policy'], 'duration_s': run['steps'] / run['decisionHz'],
                         'score': score.get('drivingScore'),
                         'route_completion': score.get('routeCompletion'),
                         'off_road': score.get('infractions', {}).get('off-road'),
                         'collisions': collision_count(score),
                         'wrong_way': score.get('infractions', {}).get('wrong-way'),
                         'mean_latency_ms': score.get('meanLatencyMs'),
                         'quant': run.get('model', {}).get('quant'),
                         'source': str(Path(path)), 'run_dir': str(run_dir)})
    for run_dir in segment.get('runs', []):
        run_dir = Path(run_dir)
        run, score = load(run_dir / 'run.json'), load(run_dir / 'score.json')
        steps = [json.loads(line) for line in (run_dir / 'steps.jsonl').read_text().splitlines()]
        latencies = [s['latencyMs'] for s in steps if s.get('latencyMs') is not None]
        rows.append({'policy': run['policy'], 'duration_s': len(steps) / run['decisionHz'],
                     'score': score.get('drivingScore'),
                     'route_completion': score.get('routeCompletion'),
                     'off_road': score.get('infractions', {}).get('off-road'),
                     'collisions': collision_count(score),
                     'wrong_way': score.get('infractions', {}).get('wrong-way'),
                     'mean_latency_ms': sum(latencies) / len(latencies) if latencies else None,
                     'quant': run.get('model', {}).get('quant'),
                     'source': str(run_dir / 'score.json'), 'run_dir': str(run_dir)})
    if not rows or len(rows) > 8:
        raise ValueError('A metrics table needs 1-8 rows; split larger tables into pages')
    return rows


def table(segment, dest):
    rows = metrics_rows(segment)
    image = canvas(segment)
    draw = ImageDraw.Draw(image)
    cols = [(64, 'POLICY'), (482, 'SIM s'), (664, 'SCORE'), (880, 'ROUTE %'),
            (1118, 'C / O / W'), (1376, 'LATENCY ms'), (1664, 'PRECISION')]
    for x, label in cols:
        draw.text((x, 234), label, font=font(25, True), fill=ACCENT)
    labels = segment.get('row_labels')
    if labels is not None and len(labels) != len(rows):
        raise ValueError('row_labels must name every metrics row in source order')
    for n, row in enumerate(rows):
        y = 292 + n * 70
        draw.rounded_rectangle((48, y - 5, 1872, y + 56), radius=8,
                               fill=PANEL if n % 2 == 0 else '#101d2d')
        values = [labels[n] if labels is not None else row['policy'], fmt(row['duration_s'], 1), fmt(row['score']),
                  fmt(None if row['route_completion'] is None else row['route_completion'] * 100, 1),
                  ' / '.join(fmt(row[key], 0) for key in ('collisions', 'off_road', 'wrong_way')),
                  fmt(row['mean_latency_ms'], 1), row['quant'] or 'n/a']
        for (x, _), value in zip(cols, values):
            text_block(draw, value, (x, y + 4), 394 if x == 64 else 185,
                       size=29, max_height=40, minimum=21)
    draw.text((64, 854), 'C / O / W: collision / off-road / wrong-way event counts. Full categories are in the linked source scores.',
              font=font(23), fill=ACCENT)
    notes = segment.get('notes', [])
    text_block(draw, '\n'.join(notes), (64, 896), 1780, size=27, fill=MUTED,
               max_height=148, minimum=22)
    image.save(dest)
    save_json(dest.with_suffix('.json'), rows)
    with dest.with_suffix('.csv').open('w') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def panel_frame(segment, row=None):
    image = canvas(segment)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((1216, 212, 1864, 1030), radius=18, fill=PANEL)
    x, width, y = 1240, 596, 232
    if row is None:
        text = '\n\n'.join(segment.get('notes', []))
        text_block(draw, text, (x, y), width, size=30, max_height=762, minimum=24)
        return image
    if segment.get('native_frames'):
        draw.text((64, 1040), 'Native camera frame at left; decision outcome telemetry at right.', font=font(23), fill=MUTED)
    y = text_block(draw, f"Decision {row['step']} | outcome t={row['tS']:.2f}s",
                   (x, y), width, size=26, fill=ACCENT, max_height=40) + 15
    speed = row.get('pose', {}).get('speedMps')
    y = text_block(draw, f"Post-step speed  {fmt(speed, 2)} m/s\nDecision latency  {fmt(row.get('latencyMs'), 1)} ms",
                   (x, y), width, size=28) + 26
    reasoning = row.get('reasoning', {'kind': 'none'})
    if reasoning.get('kind') == 'choice':
        probabilities = reasoning.get('probabilities') or {}
        heading = 'Jev choice distribution' if probabilities else 'No model distribution returned'
        y = text_block(draw, heading, (x, y), width,
                       size=32, bold=True) + 10
        y = text_block(draw, f"Selected: {reasoning.get('choice', 'unavailable')}\nConfidence: {fmt(reasoning.get('confidence'), 2)}",
                       (x, y), width, size=29) + 12
        for label, probability in probabilities.items():
            y = text_block(draw, f'{label}  {100 * probability:.1f}%', (x, y), width,
                           size=27) + 4
            draw.rounded_rectangle((x, y, x + width, y + 16), radius=5, fill='#314962')
            if probability > 0:
                draw.rectangle((x, y, x + width * min(1, probability), y + 16), fill=ACCENT)
            y += 29
        extra = row.get('extras') or {}
        reason = extra.get('fallbackReason')
        label = f'Recorded fallback: {reason}' if reason else ('Latched choice / held between requests' if extra.get('latched') else 'Fresh model choice')
        text_block(draw, label, (x, y + 10), width, size=26, fill=MUTED,
                   max_height=1020 - y - 10, minimum=22)
    else:
        heading = 'Model-reported reasoning' if reasoning.get('kind') == 'text' else 'Recorded policy telemetry'
        y = text_block(draw, heading, (x, y), width, size=32, bold=True) + 18
        text = reasoning.get('text') or 'This policy emits no text reasoning. No explanation is invented.'
        y = text_block(draw, text, (x, y), width, size=33, max_height=410, minimum=24) + 25
        target = row.get('action', {}).get('targetSpeedMps')
        if target is not None:
            y = text_block(draw, f'Target speed: {target:.2f} m/s', (x, y), width,
                           size=28, fill=ACCENT) + 17
        note = segment.get('panel_note', 'Read model text alongside the observed motion, not as a correctness guarantee.')
        text_block(draw, note, (x, y), width, size=25, fill=MUTED,
                   max_height=1020 - y, minimum=22)
    return image


def video(segment, output, scratch):
    source = Path(segment['source'])
    info = probe(source)
    speed = float(segment.get('speed', 1))
    if speed <= 0:
        raise ValueError('Playback speed must be positive')
    start = float(segment.get('trim_start_s', 0))
    run = load(Path(segment['run_dir']) / 'run.json') if segment.get('run_dir') else None
    if segment.get('closed_loop_only'):
        if run is None:
            raise ValueError('closed_loop_only requires run_dir')
        start += run['warmupFrames'] / run['decisionHz']
    available = info['duration'] - start
    source_duration = float(segment.get('source_duration_s', available))
    if source_duration <= 0 or source_duration > available + 0.05:
        raise ValueError(f'Invalid trim for {source}: {start}+{source_duration}>{info["duration"]}')
    duration = source_duration / speed
    panel = bool(run) or bool(segment.get('side_panel'))
    box = (48, 212, 1120, 818) if panel else (48, 208, 1824, 830)
    if segment.get('full_frame'):
        if panel:
            raise ValueError('full_frame is for already-annotated videos without a side panel')
        box = (0, 0, WIDTH, HEIGHT)
    x, y, width, height = box
    aspect = info['width'] / info['height']
    scaled_width = min(width, int(height * aspect)) // 2 * 2
    scaled_height = min(height, int(width / aspect)) // 2 * 2
    x += (width - scaled_width) // 2
    y += (height - scaled_height) // 2
    args = ['-ss', str(start), '-t', str(source_duration), '-i', str(source)]
    if run:
        rows = [json.loads(line) for line in (Path(segment['run_dir']) / 'steps.jsonl').read_text().splitlines()]
        hz = run['decisionHz']
        offset = round(float(segment.get('trim_start_s', 0)) * hz)
        count = round(source_duration * hz)
        selected = rows[offset:offset + count]
        if len(selected) != count:
            raise ValueError(f'{source}: expected {count} telemetry rows, got {len(selected)}')
        if segment.get('native_frames'):
            first_frame = round(start * hz)
            frame_dir = Path(segment['native_frames'])
            for frame_number in range(first_frame, first_frame + count):
                if not (frame_dir / f'{frame_number}.png').is_file():
                    raise FileNotFoundError(frame_dir / f'{frame_number}.png')
            args = ['-framerate', str(hz), '-start_number', str(first_frame),
                    '-t', str(source_duration), '-i', str(frame_dir / '%d.png')]
        for index, row in enumerate(selected):
            panel_frame(segment, row).save(scratch / f'{index:06d}.png')
        args += ['-framerate', str(hz * speed), '-i', str(scratch / '%06d.png')]
    else:
        background = panel_frame(segment) if panel else canvas(segment)
        background.save(scratch / 'background.png')
        args += ['-loop', '1', '-framerate', str(FPS), '-i', str(scratch / 'background.png')]
    numerator, denominator = map(int, info['r_frame_rate'].split('/'))
    last_frame_interval = denominator / numerator / speed
    args += ['-filter_complex',
             f'[0:v]setpts=(PTS-STARTPTS)/{speed},scale={scaled_width}:{scaled_height}:flags=lanczos,'
             f'tpad=stop_mode=clone:stop_duration={last_frame_interval}[camera];'
             f'[1:v]tpad=stop_mode=clone:stop_duration={last_frame_interval}[panel];'
             f'[panel][camera]overlay={x}:{y}:shortest=1,fps={FPS},format=yuv420p[out]',
             '-map', '[out]']
    encode(args, output, duration)
    return duration


def resolve_segment(segment, base):
    segment = dict(segment)
    def absolute(path):
        path = Path(path).expanduser()
        return str((base / path).resolve() if not path.is_absolute() else path.resolve())
    for key in ('source', 'run_dir', 'native_frames'):
        if key in segment:
            segment[key] = absolute(segment[key])
    for key in ('reports', 'runs', 'links'):
        if key in segment:
            segment[key] = [absolute(p) for p in segment[key]]
    return segment


def dependencies(segment):
    paths = list(segment.get('links', [])) + list(segment.get('reports', []))
    if segment.get('source'):
        paths.append(segment['source'])
    runs = list(segment.get('runs', []))
    if segment.get('run_dir'):
        runs.append(segment['run_dir'])
    for report in segment.get('reports', []):
        for item in load(report).get('runs', []):
            run_dir = Path(item['runDir'])
            runs.append(str(run_dir if run_dir.is_absolute() else Path(report).parent / run_dir))
    for run_dir in runs:
        for filename in ('run.json', 'steps.jsonl', 'score.json', 'result.json', 'trace.jsonl'):
            path = Path(run_dir) / filename
            if path.exists():
                paths.append(str(path))
    return sorted(set(paths))


def stamp(seconds):
    whole = int(seconds)
    return f'{whole // 3600:02d}:{whole // 60 % 60:02d}:{whole % 60:02d}'


def relative(path, output):
    return quote(os.path.relpath(path, output), safe='/')


def indexes(manifest, records, output, duration):
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    md = ['# SimForge driving + training showreel', '',
          '[OPEN ONE VIDEO: showreel.mp4](showreel.mp4)', '',
          f'Built {now}. Status: **{manifest.get("status", "snapshot")}**. '
          f'Duration: **{stamp(duration)}** ({duration:.2f} s). 1920×1080, H.264, 30 fps. '
          'Text narration; no audio. MP4 chapter metadata is embedded.', '',
          '[Browser index](index.html) · [Assembly manifest](manifest.json) · [Build receipt](build.json)', '',
          'Driving footage is native Bevy output; only text/cards/recorded telemetry are assembled here. '
          'All playback speed changes and prologue trims are labeled. Source artifacts stay at their linked paths; '
          'serve the parent drive directory for HTTP playback of all links.', '']
    md += ['## Rebuild from the recorded manifest', '',
           'From the repository root, with Python 3, Pillow, ffmpeg and ffprobe installed:', '',
           '```sh', f'python3 tools/showreel/assemble.py {output / "manifest.json"} --out {output}',
           '```', '',
           'To discover newly completed demo heats and apply explicit training/safety contributions first:', '',
           '```sh',
           f'python3 tools/showreel/manifest.py --root {output.parent} --output {output / "manifest.json"} --additions {output / "additions.json"}',
           '```', '',
           'The assembler uses CPU encoding, reuses unchanged segment clips, and replaces the main video atomically. '
           'Short-clip slow playback repeats recorded frames; it does not interpolate or synthesize driving imagery.', '']
    md += ['## Chapters and source artifacts', '']
    sections = []
    for record in records:
        seg = record['segment']
        title = f'{stamp(record["start_s"])} — {seg["title"]}'
        md += [f'### {title}', '', seg.get('description', ''), '',
               f'- [Assembled chapter clip]({relative(record["clip"], output)})']
        links = [(record['clip'], 'Assembled chapter clip')]
        for path in record.get('frames', []):
            label = 'Rendered metrics table' if seg['kind'] == 'table' else 'Narration card / dashboard frame'
            if path.endswith('.csv'):
                label = 'Metrics CSV (unrounded values)'
            elif path.endswith('.json'):
                label = 'Metrics JSON (unrounded values)'
            links.append((path, label))
        for source in record['sources']:
            links.append((source, f'Source: {Path(source).name} — {Path(source).parent.name}'))
        for path, label in links[1:]:
            md.append(f'- [{label}]({relative(path, output)})')
        md.append('')
        lis = ''.join(f'<li><a href="{html.escape(relative(path, output))}">{html.escape(label)}</a></li>' for path, label in links)
        preview = f'<img loading="lazy" src="{html.escape(relative(record["frames"][0], output))}" alt="{html.escape(seg["title"])}">' if record.get('frames') else ''
        sections.append(f'<section><h2><button data-time="{record["start_s"]:.3f}">{html.escape(title)}</button></h2><p>{html.escape(seg.get("description", ""))}</p>{preview}<ul>{lis}</ul></section>')
    md += ['## Caveats', ''] + [f'- {item}' for item in manifest.get('caveats', [])]
    caveats = ''.join(f'<li>{html.escape(item)}</li>' for item in manifest.get('caveats', []))
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SimForge driving + training showreel</title><style>body{{background:{BG};color:{FG};font:18px/1.55 system-ui;max-width:1200px;margin:32px auto;padding:0 24px}}a,button{{color:{ACCENT}}}video,img{{width:100%;height:auto;border-radius:12px}}section{{border-top:1px solid #314962;padding:24px 0}}button{{background:none;border:0;font:inherit;text-align:left;cursor:pointer}}li{{overflow-wrap:anywhere}}p{{color:{MUTED}}}h1{{line-height:1.2}}</style>
<h1>SimForge driving + training</h1><p>{html.escape(manifest.get('status', 'snapshot'))} · {stamp(duration)} · 1080p H.264 · built {now} · text narration, no audio</p>
<video id="video" controls preload="metadata" src="showreel.mp4"></video><p><a href="showreel.mp4">Open / download one video</a> · <a href="README.md">README</a> · <a href="manifest.json">Manifest</a> · <a href="build.json">Build receipt</a></p>
{''.join(sections)}<section><h2>Known caveats</h2><ul>{caveats}</ul><p>For HTTP access, serve the parent drive directory so relative source links remain reachable. Chapter buttons seek in the main video.</p></section>
<script>document.querySelectorAll('[data-time]').forEach(b=>b.addEventListener('click',()=>{{const v=document.getElementById('video');v.currentTime=Number(b.dataset.time);v.scrollIntoView({{behavior:'smooth'}});v.play();}}));</script></html>'''
    (output / 'README.md').write_text('\n'.join(md) + '\n')
    (output / 'index.html').write_text(page)
    return now


def assemble(manifest_path, output):
    manifest_path, output = Path(manifest_path).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with (output / '.assemble.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = load(manifest_path)
        segments_dir, frames_dir = output / 'segments', output / 'frames'
        segments_dir.mkdir(exist_ok=True)
        frames_dir.mkdir(exist_ok=True)
        script_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        records, cursor, seen = [], 0.0, set()
        for original in manifest['segments']:
            seg = resolve_segment(original, manifest_path.parent)
            identity = seg['id']
            if identity in seen or not all(c.isalnum() or c in '-_' for c in identity):
                raise ValueError(f'Duplicate or unsafe segment id: {identity}')
            seen.add(identity)
            sources = dependencies(seg)
            fingerprint = [(p, Path(p).stat().st_size, Path(p).stat().st_mtime_ns) for p in sources]
            key = hashlib.sha256(json.dumps([seg, fingerprint, script_digest], sort_keys=True).encode()).hexdigest()[:12]
            clip = segments_dir / f'{identity}-{key}.mp4'
            frame = frames_dir / f'{identity}-{key}.png'
            frames = []
            if not clip.exists():
                print(f'ASSEMBLING {identity}', flush=True)
                with tempfile.TemporaryDirectory(prefix='showreel-') as scratch_path:
                    scratch = Path(scratch_path)
                    staged = scratch / 'clip.mp4'
                    kind = seg['kind']
                    duration = float(seg.get('duration_s', 10))
                    if kind == 'video':
                        video(seg, staged, scratch)
                    else:
                        if kind == 'card':
                            card(seg, frame)
                        elif kind == 'table':
                            table(seg, frame)
                        elif kind == 'image':
                            image = canvas(seg)
                            source_image = Image.open(seg['source']).convert('RGB')
                            source_image = ImageOps.contain(source_image, (1824, 830), Image.Resampling.LANCZOS)
                            image.paste(source_image, ((WIDTH-source_image.width)//2, 208+(830-source_image.height)//2))
                            image.save(frame)
                        else:
                            raise ValueError(f'Unknown segment kind: {kind}')
                        encode(['-loop', '1', '-framerate', str(FPS), '-i', str(frame)], staged, duration)
                    os.replace(staged, clip)
            else:
                print(f'CACHED {identity}', flush=True)
            duration = probe(clip)['duration']
            if frame.exists():
                frames.append(str(frame))
            if seg['kind'] == 'table':
                frames += [str(frame.with_suffix(suffix)) for suffix in ('.csv', '.json')]
            records.append({'segment': seg, 'clip': str(clip), 'sources': sources,
                            'frames': frames, 'start_s': cursor, 'duration_s': duration})
            cursor += duration
        if not records:
            raise ValueError('Manifest has no segments')
        with tempfile.TemporaryDirectory(prefix='showreel-concat-') as scratch_path:
            scratch = Path(scratch_path)
            concat = scratch / 'concat.txt'
            concat.write_text(''.join("file '" + r['clip'].replace("'", "'\\''") + "'\n" for r in records))
            metadata = [';FFMETADATA1', 'title=SimForge driving and training evidence',
                        'comment=Text narration. Native driving footage and recorded metrics only.']
            for record in records:
                title = record['segment']['title']
                for char in ('\\', '=', ';', '#', '\n'):
                    title = title.replace(char, '\\' + char)
                metadata += ['[CHAPTER]', 'TIMEBASE=1/1000', f'START={round(record["start_s"]*1000)}',
                             f'END={round((record["start_s"]+record["duration_s"])*1000)}', f'title={title}']
            (scratch / 'chapters.txt').write_text('\n'.join(metadata) + '\n')
            staged = output / '.showreel.staging.mp4'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat',
                            '-safe', '0', '-i', str(concat), '-i', str(scratch / 'chapters.txt'),
                            '-map', '0:v:0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy',
                            '-movflags', '+faststart', str(staged)], check=True)
            actual = probe(staged)
            if actual['width'] != WIDTH or actual['height'] != HEIGHT or actual['codec_name'] != 'h264':
                raise ValueError(f'Unexpected output format: {actual}')
            if abs(actual['duration'] - cursor) > 0.2:
                raise ValueError(f'Unexpected output duration: {actual["duration"]} vs {cursor}')
            os.replace(staged, output / 'showreel.mp4')
        save_json(output / 'manifest.json', manifest)
        built_at = indexes(manifest, records, output, cursor)
        receipt = {'schema': 'simforge.showreel-build/v1', 'built_at': built_at,
                   'status': manifest.get('status'), 'video': str(output / 'showreel.mp4'),
                   'duration_s': actual['duration'], 'width': WIDTH, 'height': HEIGHT,
                   'codec': 'h264', 'fps': FPS, 'segments': records,
                   'manifest_sha256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()}
        save_json(output / 'build.json', receipt)
        print(f'READY {output / "showreel.mp4"} duration={actual["duration"]:.3f}s chapters={len(records)}', flush=True)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assemble(args.manifest, args.out)


if __name__ == '__main__':
    main()
