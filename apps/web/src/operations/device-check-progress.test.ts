// The first face on a new device: its device check moves the face's bar, and the face itself still finishes it.
// The fake bridge emits what product-bridge emits for the check (stage 'canary', its line, the share under way).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationService } from './bridge-service.ts';
import { face, fakeBridge, flush, output } from './fake-bridge.ts';
import type { OperationEvent } from './service.ts';

test('the device check advances the first face’s bar step by step, short of done', async () => {
  const fake = fakeBridge();
  const service = createOperationService({ bridge: fake.bridge });
  const handle = service.requestFace(face('a'));
  const bar: (number | null)[] = [];
  const lines: string[] = [];
  service.subscribe((event: OperationEvent) => {
    if (event.intent.requestId !== handle.requestId || event.type !== 'progress') return;
    bar.push(event.action.fraction);
    lines.push(event.line ?? '');
  });
  await flush();
  const job = fake.executions.at(-1)!;
  const id = job.request.jobId;
  // Before the model is here the check's first announcement carries no share and must not finish the download.
  fake.progress(id, 'canary', 'Checking this device…', { fraction: 0 });
  fake.progress(id, 'asset-acquisition', 'Downloading model files… 23 MB of 158 MB', {
    loaded: 23,
    total: 158,
  });
  const beforeCheck = bar.at(-1)!;
  assert.ok(beforeCheck < 0.15, `still downloading (${beforeCheck})`);
  for (let step = 1; step <= 7; step++)
    fake.progress(id, 'canary', `Checking this device… step ${step} of 7`, {
      fraction: (step - 0.5) / 7,
    });
  const during = bar.slice(-7);
  for (let i = 1; i < during.length; i++)
    assert.ok(during[i]! > during[i - 1]!, `step ${i + 1} moves the bar (${during.join(', ')})`);
  assert.ok(during[0]! >= 0.25, 'download and load are behind the check');
  assert.ok(during.at(-1)! < 0.9, 'the check alone never looks finished');
  assert.equal(lines.at(-1), 'Checking this device… step 7 of 7');
  fake.progress(id, 'synthesis', 'Generating…');
  assert.equal(lines.at(-1), 'Generating…');
  job.resolve(output(['a']));
  await flush();
});
