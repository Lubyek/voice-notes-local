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
      SHARES: bindings.kv({ id: "f2f5c6ebf51045889c2b414c8a6b9607" }),
      PER_IP: bindings.rateLimit({ namespace: "73516421", simple: { limit: 20, period: 60 } }),
      TOTAL: bindings.rateLimit({ namespace: "73516422", simple: { limit: 60, period: 60 } }),
    },
  },
});
