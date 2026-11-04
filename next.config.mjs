/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Transformers.js and ONNX runtime ship WASM + dynamic requires that must
    // stay outside the bundler graph; keep them server-external so the browser
    // worker can load them from /public or the CDN instead.
    serverComponentsExternalPackages: ['@xenova/transformers'],
  },
  webpack: (config) => {
    // `sharp` and `onnxruntime-node` are optional native backends of
    // Transformers.js. They are never used in the browser build and their
    // native bindings break the bundle; alias them to false.
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp: false,
      'onnxruntime-node': false,
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
