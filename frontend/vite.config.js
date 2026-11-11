
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_URL?.trim();

  if (mode === "development" && !apiTarget) {
    console.warn("VITE_API_URL is not set. Configure it with the existing Render backend URL to enable the /api development proxy.");
  }

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
