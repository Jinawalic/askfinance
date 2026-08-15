import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf uses WASM internally — no special config needed
  // Removed pdf-parse (caused native canvas dependency crashes on Vercel)

  // Allow HMR WebSocket connections from tunnel URLs (*.loca.lt, *.trycloudflare.com)
  allowedDevOrigins: ["*.loca.lt", "*.trycloudflare.com"],
};

export default nextConfig;
