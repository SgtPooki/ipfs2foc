#!/usr/bin/env node
/**
 * Bin entry. Checks the Node version before importing anything that pulls in
 * `node:sqlite`, so an old runtime gets a clear message instead of a cryptic
 * `ERR_UNKNOWN_BUILTIN_MODULE`. The real CLI loads via dynamic import only
 * after the check passes.
 */
const major = Number(process.versions.node.split('.')[0])
if (major < 26) {
  process.stderr.write(
    `ipfs2foc requires Node.js >= 26 (found ${process.versions.node}).\n` +
      `It uses the built-in node:sqlite module. Install Node 26+ from https://nodejs.org\n`
  )
  process.exit(1)
}

await import('./index.ts')
