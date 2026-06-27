import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  // Prefer ESM entry points. jsonc-parser's "main" is a UMD build whose
  // require("./impl/*") esbuild can't statically follow (it leaves a runtime
  // __require that fails once installed); its "module" (ESM) build bundles
  // cleanly. Node platform otherwise defaults to ['main', 'module'].
  mainFields: ['module', 'main'],
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
