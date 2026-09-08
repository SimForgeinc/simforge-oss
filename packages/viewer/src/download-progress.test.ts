import { describe, expect, it } from 'vitest';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';

describe('asset download telemetry', () => {
  it('reports network speed and stalls without claiming a discovered subtotal is the scope total', () => {
    const tracker = new AssetDownloadTracker();
    const transfer = tracker.begin();
    tracker.advance(transfer, 200, 100);
    tracker.advance(transfer, 300, 1_100);
    expect(tracker.snapshot(1_100)).toMatchObject({
      active: 1, transferredBytes: 500, totalBytes: null,
      discoveryComplete: false, bytesPerSecond: 300, stalledForMs: 0,
    });
    expect(tracker.snapshot(4_200)).toMatchObject({ bytesPerSecond: 0, stalledForMs: 3_100 });
  });

  it('keeps batch gaps unknown until the viewer settles, and reopens on new work', () => {
    const tracker = new AssetDownloadTracker();
    const first = tracker.begin();
    tracker.advance(first, 10);
    tracker.finish(first);
    expect(tracker.snapshot()).toMatchObject({ active: 0, totalBytes: null, discoveryComplete: false });
    const second = tracker.begin();
    expect(tracker.snapshot(1_000, true).discoveryComplete).toBe(false);
    tracker.advance(second, 20);
    tracker.finish(second);
    expect(tracker.snapshot(1_000, true)).toMatchObject({ totalBytes: 30, discoveryComplete: true });
    expect(tracker.snapshot(1_001, false)).toMatchObject({ totalBytes: null, discoveryComplete: false });
  });

  it('ignores both stale chunks and responses arriving after a session reset', async () => {
    const tracker = new AssetDownloadTracker();
    const sessionId = tracker.sessionId;
    const stale = tracker.begin();
    const decoded = tracker.trackDecode();
    tracker.advance(stale, 300, 100);
    tracker.reset();
    tracker.advance(stale, 400, 200);
    tracker.finish(stale, 300);
    decoded();
    const body = await readResponseBufferWithProgress(new Response('old'), tracker, undefined, sessionId);
    expect(new TextDecoder().decode(body)).toBe('old');
    expect(tracker.decodedAssets).toBe(0);
    expect(tracker.snapshot(300)).toMatchObject({
      active: 0, transferredBytes: 0, cachedBytes: 0, totalBytes: null, discoveryComplete: false,
    });
  });

  it('uses actual body bytes for unknown or mismatched sizes once scope settles', async () => {
    const tracker = new AssetDownloadTracker();
    const buffer = await readResponseBufferWithProgress(new Response('hello world'), tracker, 20);
    expect(new TextDecoder().decode(buffer)).toBe('hello world');
    await readResponseBufferWithProgress(new Response('!'), tracker);
    expect(tracker.snapshot()).toMatchObject({ active: 0, transferredBytes: 12, totalBytes: null });
    expect(tracker.snapshot(1_000, true).totalBytes).toBe(12);
  });

  it('excludes cached body reads from network totals and transfer rate', async () => {
    const tracker = new AssetDownloadTracker();
    await readResponseBufferWithProgress(new Response('cached', { headers: { 'x-simforge-cache': 'hit' } }), tracker);
    const network = tracker.begin();
    tracker.advance(network, 100, 100);
    const cached = tracker.begin(true);
    tracker.advance(cached, 1_000, 600);
    tracker.advance(network, 100, 1_100);
    tracker.finish(network, 1_100);
    expect(tracker.snapshot(1_200)).toMatchObject({
      active: 0, transferredBytes: 200, cachedBytes: 1_006, bytesPerSecond: null, stalledForMs: 0,
    });
    expect(tracker.snapshot(1_200, true).discoveryComplete).toBe(false);
    tracker.finish(cached, 1_200);
    expect(tracker.snapshot(1_200, true)).toMatchObject({ totalBytes: 200, discoveryComplete: true });
  });
});
