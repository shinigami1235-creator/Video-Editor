// Copies the ONNX Runtime WebAssembly files the smart tools need into public/ort.
// Runs after `npm install`, since the files are too large to keep in the project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath handles Windows drive letters and the spaces in "Coding Projects"
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dest = path.join(root, 'public', 'ort');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) {
    console.error('Missing ' + from);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(from, path.join(dest, f));
}
console.log('ONNX Runtime files copied to public/ort');
