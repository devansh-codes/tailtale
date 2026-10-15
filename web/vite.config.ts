import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Local dev: `wrangler dev` (worker/) on :8787 serves /api; generated data is symlinked into public/data.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  preview: { proxy: { "/api": "http://127.0.0.1:8787" } },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["maplibre-gl"] },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1100, // MapLibre is a lazily loaded chunk by design
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
