// SPDX-License-Identifier: MIT OR Apache-2.0
// Built-in AI background removal, off the UI thread. The weights are bundled with the app
// under /models/matting (public/models/matting, produced by scripts/fetch-matting-model.mjs),
// so at runtime this worker makes NO network requests at all.

import { env, pipeline, RawImage } from '@huggingface/transformers';

const MODEL = 'matting';
const LOCAL_ROOT = '/models/';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = LOCAL_ROOT;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = undefined;

let segmenter = null;
const files = new Map();
const progress = (p) => {
  if (p.status !== 'progress' || !p.total) return;
  files.set(p.file, [p.loaded, p.total]);
  let loaded = 0, total = 0;
  for (const [l, t] of files.values()) (loaded += l), (total += t);
  self.postMessage({ type: 'download', loaded, total });
};

self.onmessage = async ({ data }) => {
  try {
    if (!segmenter) {
      // Fail fast with a clear message when the bundled model files are absent.
      const probe = await fetch(LOCAL_ROOT + MODEL + '/config.json');
      if (!probe.ok) {
        self.postMessage({ type: 'missing', text: 'Local model files not found' });
        return;
      }
      self.postMessage({ type: 'status', text: 'Loading the matting model…' });
      segmenter = await pipeline('background-removal', MODEL, { device: 'wasm', dtype: 'fp32', progress_callback: progress });
    }
    self.postMessage({ type: 'status', text: 'Removing the background…' });
    const image = new RawImage(new Uint8ClampedArray(data.pixels), data.width, data.height, 4);
    const out = await segmenter(image);
    const pixels = new Uint8ClampedArray(out.data);
    self.postMessage({ type: 'done', pixels, width: out.width, height: out.height }, [pixels.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', text: e?.message ?? String(e) });
  }
};
