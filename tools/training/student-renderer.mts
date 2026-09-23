import { promises as fs } from 'node:fs';
import { startNativeRenderService } from '../../packages/render/src/native/service-process.js';
const [scenePath, binary, workspace] = process.argv.slice(2);
if (!scenePath || !binary || !workspace) throw new Error('usage: student-renderer.mts SCENE BINARY WORKSPACE');
const controller = new AbortController();
const service = await startNativeRenderService({ scenePath, binary, workspace, jobId: 'student-training', signal: controller.signal });
await service.client.close();
await fs.writeFile(`${workspace}/student-renderer.json`, JSON.stringify({ socket: service.socket, protocol: service.protocol, scenePath, binary }));
console.log(`RENDERER_READY ${service.socket}`);
await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
});
await service.close();
