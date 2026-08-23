/**
 * Ink statically imports react-devtools-core from a module it only loads when DEV is set.
 * Bundling pulls the import in anyway, so it is resolved to an empty stub rather than
 * shipped as an external that node would then fail to find at startup.
 */
import { chmodSync } from 'node:fs'

const stub = {
  name: 'stub-react-devtools',
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function connectToDevTools() {}\nexport default {}',
      loader: 'js' as const,
    }))
  },
}

const result = await Bun.build({
  entrypoints: ['src/bin.ts'],
  target: 'node',
  outdir: 'dist',
  naming: 'cli.js',
  plugins: [stub],
  minify: false,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

chmodSync('dist/cli.js', 0o755)
console.log(`dist/cli.js  ${(result.outputs[0]!.size / 1024).toFixed(0)} kB`)
