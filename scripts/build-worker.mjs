import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
await rm('dist/worker', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, external: ['cloudflare:workers'] });
await copyFile('wrangler.jsonc', 'dist/wrangler.jsonc');
