import { defineConfig, devices } from "@playwright/test";

// Smoke test runs against a production build in fixture mode with no LLM, so it
// never spends Qloo quota or model credits, even when .env.local holds keys.
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { CROSSOVER_MODE: "fixture", LLM_PROVIDER: "none", QLOO_API_KEY: "", LLM_API_KEY: "", ANTHROPIC_API_KEY: "" },
  },
});
