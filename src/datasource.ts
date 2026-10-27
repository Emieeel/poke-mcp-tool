/**
 * datasource.ts — one lazily loaded JSON dataset (dex, items, moves, abilities).
 *
 * The data arrives either INJECTED (Cloudflare Workers bundle the JSON and call provide()) or
 * through a disk LOADER that the Node-only src/diskdata.ts registers. This module stays free of
 * `node:*` imports so it bundles for filesystem-less runtimes. `build` turns the raw JSON into
 * whatever index the caller looks things up in; get() returns null when no data is available.
 */
export function dataSource<Raw, Index>(build: (raw: Raw) => Index) {
  let injected: Raw | undefined;
  let loader: (() => Raw | null) | undefined;
  let cache: Index | null | undefined;
  return {
    provide(raw: unknown): void {
      injected = raw as Raw;
      cache = undefined;
    },
    register(load: () => Raw | null): void {
      loader = load;
      cache = undefined;
    },
    get(): Index | null {
      if (cache === undefined) {
        const raw = injected ?? loader?.() ?? null;
        cache = raw ? build(raw) : null;
      }
      return cache;
    },
  };
}
