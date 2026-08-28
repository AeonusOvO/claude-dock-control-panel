import { parentPort, workerData } from 'node:worker_threads';
import { TranscriptUsageReader, type TranscriptUsageRequest } from './transcript-reader';

const port = parentPort;
if (port) {
  const reader = new TranscriptUsageReader(workerData.projectsRoot as string);
  let queue = Promise.resolve();
  port.on('message', (request: TranscriptUsageRequest) => {
    queue = queue.then(async () => {
      try {
        port.postMessage({ epoch: request.epoch, results: await reader.read(request) });
      } catch {
        port.postMessage({ epoch: request.epoch, unavailable: true });
      }
    });
  });
}
