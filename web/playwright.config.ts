import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", ...devices["Pixel 5"], viewport: { width: 360, height: 780 } },
  webServer: { command: "npx vite preview --port 4173 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
