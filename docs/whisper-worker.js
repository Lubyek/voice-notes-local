let model;

self.onmessage = async ({ data: { audio, language } }) => {
  try {
    if (!model) {
      self.postMessage({ progress: "Загружаем модель Whisper…" });
      const { env, pipeline } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js");
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      model = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", {
        device: "wasm", dtype: "q8",
      });
    }
    self.postMessage({ progress: "Распознаём запись…" });
    const result = await model(audio, { chunk_length_s: 25, stride_length_s: 4, task: "transcribe", language });
    self.postMessage({ text: result.text.replace(/\s+/g, " ").trim() });
  } catch (error) {
    console.error(error);
    self.postMessage({ error: "Whisper не смог обработать запись. Проверь интернет для загрузки модели и попробуй ещё раз." });
  }
};
