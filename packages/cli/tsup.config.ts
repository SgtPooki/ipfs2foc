import { defineConfig } from 'tsup'

// Bundle the CLI's own source into dist, leaving npm dependencies external (they
// install from the published package.json as before). The entry is the bin
// launcher; its `await import('./index.ts')` stays a separate chunk via code
// splitting, so the Node-version guard in cli.ts still runs before anything
// pulls in node:sqlite (see src/cli.ts). The shebang is preserved automatically.
//
// `noExternal` is where a bundled internal workspace package (e.g. a future
// `ipfs2foc-core`) would be inlined so the published package needs no extra
// dependency.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: true,
  dts: false,
  sourcemap: false,
  // esbuild (this version) doesn't recognize the newer `node:sqlite` builtin and
  // strips its `node:` prefix at print time to a bare `sqlite` that Node can't
  // resolve. Restore the prefix on the import specifier after the build. Scoped
  // to `from "sqlite"` / `from"sqlite"` import forms only, so SQL strings and
  // `sqliteVersion` identifiers are untouched.
  async onSuccess() {
    const { readdir, readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    for (const file of await readdir('dist')) {
      if (!file.endsWith('.js')) continue
      const path = join('dist', file)
      const src = await readFile(path, 'utf8')
      const fixed = src.replace(/from(\s*)"sqlite"/g, 'from$1"node:sqlite"')
      if (fixed !== src) await writeFile(path, fixed)
    }
  },
  // Inline the internal workspace package so the published CLI is self-contained
  // (no `ipfs2foc-core` runtime dependency to resolve).
  noExternal: ['ipfs2foc-core'],
})
