import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "voice-notes-assemblyai",
    compatibilityDate: "2026-11-19",
    entrypoint: "./worker/transcription.mjs",
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      PER_IP: bindings.rateLimit({ namespace: "73516421", simple: { limit: 6, period: 60 } }),
      TOTAL: bindings.rateLimit({ namespace: "73516422", simple: { limit: 30, period: 60 } }),
    },
  },
});
