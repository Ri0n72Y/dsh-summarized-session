import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'dsh-summarized-session',
    entry: { index: 'src/index.ts', preset: 'src/preset.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    tsconfig: 'tsconfig.host.json',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    name: 'dsh-summarized-session/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    tsconfig: 'tsconfig.client.json',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: ['react', 'react/jsx-runtime'] },
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-summarized-session", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
