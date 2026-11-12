
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_URL?.trim() || "http://localhost:5000";

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
