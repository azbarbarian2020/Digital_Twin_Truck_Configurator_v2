import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["snowflake-sdk"],
  images: {
    unoptimized: true,
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://localhost:8000";
    return [
      {
        source: "/api/models",
        destination: `${backendUrl}/api/models`,
      },
      {
        source: "/api/options",
        destination: `${backendUrl}/api/options`,
      },
      {
        source: "/api/configs",
        destination: `${backendUrl}/api/configs`,
      },
      {
        source: "/api/chat",
        destination: `${backendUrl}/api/chat`,
      },
      {
        source: "/api/validate",
        destination: `${backendUrl}/api/validate`,
      },
      {
        source: "/api/describe",
        destination: `${backendUrl}/api/describe`,
      },
    ];
  },
};

export default nextConfig;
