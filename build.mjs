/**
 * 构建脚本：esbuild 打两个产物。
 * - host：src/index.ts → lib/index.js（esm/node，@deepseek-ai/* 与 patchright 外置，由插件依赖提供）
 * - client：src/client/index.tsx → lib/client.js（cjs/browser，外置仅限 dsh 基座 8 词，
 *   产物包成 window.__ModuleLoader__ 的 lazy-CJS factory，id = package.json name）
 * 用法：node build.mjs [--watch]
 */
import { readFileSync } from 'node:fs'
import { build, context } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const watch = process.argv.includes('--watch')

/** client bundle 只允许这些 external（运行期由 dsh 模块表回答，见 dsh-client-web PLATFORM_MODULES）。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'lib/index.js',
  // @deepseek-ai/* 与 patchright 是真依赖，运行期由 node 解析，不打进产物
  external: ['@deepseek-ai/*', 'patchright'],
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const clientOptions = {
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2020',
  outfile: 'lib/client.js',
  external: CLIENT_EXTERNALS,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
}

if (watch) {
  const [hostCtx, clientCtx] = await Promise.all([context(hostOptions), context(clientOptions)])
  await Promise.all([hostCtx.watch(), clientCtx.watch()])
  console.log('watching src/ ...')
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
}
