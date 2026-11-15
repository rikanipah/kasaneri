import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const { name, productName, version, main } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const applicationFiles = [
  'main.cjs', 'preload.cjs', 'onboarding-preload.cjs', 'worker.cjs', 'renderer.js',
  'index.html', 'onboarding.html', 'styles.css', 'fonts', 'katex', 'xterm',
];

export function copyApplication(destination) {
  const dist = join(destination, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const file of applicationFiles)
    cpSync(join('dist', file), join(dist, file), { recursive: true });
  writeFileSync(join(destination, 'package.json'), JSON.stringify({ name, productName, version, main }, null, 2));
}
