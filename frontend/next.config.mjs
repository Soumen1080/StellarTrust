/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @stellartrust/shared ships TS/ESM; let Next transpile it.
  transpilePackages: ["@stellartrust/shared"],
};

export default nextConfig;
