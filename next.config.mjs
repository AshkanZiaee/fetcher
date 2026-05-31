/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API routes read config/*.json and config/profile.md at runtime via fs.
  // Tell Vercel to include those files in the serverless function bundle,
  // otherwise they 404 in production.
  outputFileTracingIncludes: {
    "/**": ["./config/**"],
  },
};

export default nextConfig;
