// SPDX-License-Identifier: MIT OR Apache-2.0
// Fetches a browser-sized background-removal model into public/models/matting so the editor
// runs AI matting fully offline. BiRefNet (min 115MB fp16, fixed 1024x1024 input) exhausts
// ONNX Runtime's WASM memory, so we bundle Xenova/modnet (13MB, 512x512) instead.
// The model files are gitignored: run this once on a machine with network access.
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.HF_HOST || 'https://hf-mirror.com';
const REPO = process.env.HF_REPO || 'Xenova/modnet';
const OUT = path.resolve('public/models/matting');
const FILES = [
  ['config.json', 'config.json'],
  ['preprocessor_config.json', 'preprocessor_config.json'],
  ['onnx/model_fp16.onnx', 'onnx/model.onnx'],
];

fs.mkdirSync(path.join(OUT, 'onnx'), { recursive: true });
for (const [src, dst] of FILES) {
  const url = HOST + '/' + REPO + '/resolve/main/' + src;
  const target = path.join(OUT, dst);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log('skip (exists)', dst);
    continue;
  }
  console.log('GET', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log('saved', dst, (buf.length / 1e6).toFixed(1) + ' MB');
}
console.log('DONE local model ready at', OUT);
