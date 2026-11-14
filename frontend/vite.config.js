
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveApiBase } from "./src/api-config.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (mode === 'production' && (!env.VITE_API_URL || !env.VITE_API_URL.startsWith('https://') || /localhost|127\.0\.0\.1/.test(env.VITE_API_URL))) {
    throw new Error('Production builds require VITE_API_URL set to the public HTTPS backend origin.');
  }
  const apiTarget = resolveApiBase({ VITE_API_URL: env.VITE_API_URL || "http://localhost:5000" }).replace(/\/api$/, "");

  return {
    base: "/technovalens/",
    plugins: [react()],
    server: {
      proxy: apiTarget
        ? {
            "/api": {
              target: apiTarget,
              changeOrigin: true,
              secure: true
            }
          }
        : {}
    }
  };
});
