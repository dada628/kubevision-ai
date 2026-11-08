/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `three` ships bare ESM that the App Router bundler must compile itself.
  transpilePackages: ['three'],
  experimental: {
    // Transformers.js and ONNX runtime ship WASM + dynamic requires that must
    // stay outside the server graph; the browser worker loads them instead.
    serverComponentsExternalPackages: ['@xenova/transformers'],
  },
  webpack: (config) => {
    // `sharp` and `onnxruntime-node` are optional native backends of
    // Transformers.js. The `$` suffix is an exact-match alias so the package
    // entry is dropped; the unsuffixed keys cover any subpath import. Neither
    // backend is used in the browser, and their native bindings break
    // `next build`.
    config.resolve.alias = {
      ...config.resolve.alias,
      'sharp$': false,
      'onnxruntime-node$': false,
      sharp: false,
      'onnxruntime-node': false,
    };
    // Node builtins pulled in by the ONNX loader. Empty fallbacks keep the
    // production browser bundle from polyfilling (and then failing to resolve)
    // them. Web Crypto stays on `globalThis.crypto`; this only blocks the
    // Node `crypto` module.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
