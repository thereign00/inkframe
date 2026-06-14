import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "fluent-ffmpeg", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"],
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
