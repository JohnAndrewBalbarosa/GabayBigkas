import { build } from 'esbuild';
import { mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';

const outputs = [
  { name: 'lab', entry: 'frontend/lab/app.mjs', source: 'frontend/lab', files: ['index.html', 'style.css'] },
  { name: 'coach', entry: 'frontend/shell/app.mjs', source: 'frontend/shell', files: ['index.html'] },
];
for (const target of outputs) {
  const output = `.artifacts/build/${target.name}`;
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await build({ entryPoints: [target.entry], bundle: true, splitting: true, format: 'esm', outdir: output, minify: true, sourcemap: false, target: 'es2022', logLevel: 'silent' });
  await Promise.all(target.files.map(file => copyFile(`${target.source}/${file}`, `${output}/${file}`)));
  if (target.name === 'coach') await writeCoachApiBase(output);
}
console.log(JSON.stringify({ event: 'build.succeeded', outputs: outputs.map(target => `.artifacts/build/${target.name}`) }));

async function writeCoachApiBase(output) {
  const path = `${output}/index.html`;
  const html = await readFile(path, 'utf8');
  const apiBaseUrl = process.env.COACH_PUBLIC_API_BASE_URL ?? '';
  const config = `<script>globalThis.GABAYBIGKAS_API_BASE_URL=${JSON.stringify(apiBaseUrl)}</script>`;
  await writeFile(path, html.replace('</head>', `  ${config}\n</head>`));
}
