/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // packages/shared ships TypeScript source, not a build artefact. One definition,
  // both sides (CLAUDE.md §3) — no duplicated types, no build step between.
  transpilePackages: ['@razorveda/shared'],

  webpack: (config) => {
    // The shared package writes ESM-correct imports — `./enums.js` for a file that
    // is `enums.ts` on disk. Node and tsx resolve that; webpack does not, and
    // fails with "Can't resolve './enums.js'".
    //
    // The alternative is dropping the extensions, which would break Node ESM. So
    // webpack is told the mapping instead of the source being made wrong for it.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
export default nextConfig;
