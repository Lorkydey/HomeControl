import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 320, height: 540 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
});
