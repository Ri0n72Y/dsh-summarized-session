import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.tsx',
  },
  format: 'esm',
  dts: true,
  clean: true,
  external: [/^@deepseek-ai\//, 'react', 'react/jsx-runtime'],
})
