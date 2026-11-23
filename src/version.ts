import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** Version from the package.json shipped with this build (../package.json from src/ or dist/). */
export function version(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached ?? "unknown";
}
