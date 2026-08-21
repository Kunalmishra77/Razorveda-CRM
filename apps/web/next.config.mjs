/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // packages/shared ships TypeScript source, not a build artefact. One definition,
  // both sides (CLAUDE.md section 3) — no duplicated types, no build step between.
  transpilePackages: ['@razorveda/shared'],
};
export default nextConfig;
