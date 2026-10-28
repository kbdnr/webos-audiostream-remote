/*
 * Builds the app and its service into dist/ and packs both into one IPK with
 * @webosbrew/webos-packager-plugin. The plugin packs every emitted asset, so everything the TV
 * needs must pass through webpack: JS is bundled, the rest is copied. package.json is the single
 * source of the version.
 */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const { hoc } = require('@webosbrew/webos-packager-plugin');
const pkg = require('./package.json');
const appinfo = require('./frontend/appinfo.json');
const servicePkg = require('./service/package.json');

const withVersion = (content) => JSON.stringify(
  Object.assign(JSON.parse(content.toString()), { version: pkg.version }), null, 2);

module.exports = hoc({
  id: appinfo.id,
  version: pkg.version,
  options: {
    // <id>.manifest.json (with the IPK's sha256) for a self-hosted Homebrew Channel repo.
    emitManifest: true,
    manifest: {
      title: appinfo.title,
      description: pkg.description,
      iconUrl: '',
      sourceUrl: 'https://github.com/kbdnr/webos-audiostream-remote',
      rootRequired: true,
    },
  },
  app: (env, argv) => ({
    id: appinfo.id,
    mode: argv.mode || 'production',
    // Old webOS Chromium (38 on webOS 3.x): keep webpack's runtime and minifier output ES5.
    target: ['web', 'es5'],
    devtool: false,
    entry: { app: './frontend/app.js' },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      // The service compilation writes to dist/service; don't let this one wipe it.
      clean: { keep: /^service\// },
    },
    performance: { hints: false },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'frontend/index.html' },
          { from: 'frontend/style.css' },
          { from: 'frontend/*.png', to: '[name][ext]' },
          { from: 'frontend/appinfo.json', transform: withVersion },
        ],
      }),
    ],
  }),
  services: [
    (env, argv) => ({
      id: servicePkg.name,
      mode: argv.mode || 'production',
      // webOS 4 runs services on Node 0.12: webpack's runtime must be ES5 too.
      target: ['node', 'es5'],
      devtool: false,
      // tv-stream.js is its own entry because the service spawns it as a separate process.
      entry: { service: './service/service.js', 'tv-stream': './service/tv-stream.js' },
      output: {
        path: path.resolve(__dirname, 'dist/service'),
        filename: '[name].js',
        clean: true,
      },
      // Provided by the TV's JS service runtime.
      externals: { 'webos-service': 'commonjs webos-service' },
      // Real paths at runtime: the service finds tv-stream.js and autostart.sh next to itself.
      node: { __dirname: false, __filename: false },
      // Unminified so the code on the TV can be read and debugged over SSH.
      optimization: { minimize: false },
      performance: { hints: false },
      plugins: [
        new CopyPlugin({
          patterns: [
            { from: 'service/services.json' },
            { from: 'service/package.json', transform: withVersion },
            { from: 'service/autostart.sh' },
            // The web remote page, served by tv-stream.js.
            { from: 'service/remote.html' },
            // Read-only report, run from the app's "Run diagnostics" button or over SSH.
            { from: 'service/diagnose.sh' },
            // Captures audio through LG's DILE API on TVs without an ALSA capture device.
            // Built by scripts/build-native.sh (npm run native); packed as 0755 since it's ELF.
            { from: 'native/build/dile-capture' },
          ],
        }),
      ],
    }),
  ],
});
