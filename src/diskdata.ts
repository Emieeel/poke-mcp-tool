/**
 * diskdata.ts — the ONE place that reads the bundled datasets from the filesystem.
 *
 * This module is Node-only (it imports `node:fs`/`node:path`/`node:url`) and is imported by
 * the stdio entry (src/index.ts) for its side effects: it registers disk loaders with the
 * pure data modules (dex / items / regulations). Those modules themselves stay free of any
 * `node:*` import so they can be bundled for Cloudflare Workers, which inject data instead.
 *
 * Import order matters: src/index.ts must import this BEFORE the first tool call so the
 * loaders are registered when a tool lazily loads its data.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { registerDexLoader } from './dex.js';
import { registerItemsLoader } from './items.js';
import { registerRegulationLoader } from './regulations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/diskdata.js -> ../data ; src/diskdata.ts -> ../data
const DATA_DIR = join(__dirname, '..', 'data');
const REGULATIONS_DIR = join(__dirname, '..', 'regulations');

const DEX_FILE = join(DATA_DIR, 'champions-dex.json');
const ITEMS_FILE = join(DATA_DIR, 'champions-items.json');

function readJson(file: string, label: string): any | null {
  if (!existsSync(file)) {
    console.error(`[${label}] ${file} not found — falling back. Run the relevant scraper.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[${label}] Failed to read ${file}: ${(err as Error).message}. Falling back.`);
    return null;
  }
}

registerDexLoader(() => readJson(DEX_FILE, 'dex'));
registerItemsLoader(() => readJson(ITEMS_FILE, 'items'));
registerRegulationLoader({
  list() {
    if (!existsSync(REGULATIONS_DIR)) return [];
    return readdirSync(REGULATIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  },
  read(id: string) {
    const file = join(REGULATIONS_DIR, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Regulation file ${file} is not valid JSON: ${(err as Error).message}`);
    }
  },
});
