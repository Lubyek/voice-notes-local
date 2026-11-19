let model;
let Tensor;

async function detectLanguage(audio) {
  const { decoder_start_token_id, lang_to_id } = model.model.generation_config;
  const { input_features } = await model.processor(audio.subarray(0, 30 * 16_000));
  const { logits } = await model.model({
    input_features,
    decoder_input_ids: new Tensor("int64", [BigInt(decoder_start_token_id)], [1, 1]),
  });
  // Whisper's first decoder step predicts the language from the language tokens.
  let bestLanguage;
  let bestScore = -Infinity;
  for (const [token, id] of Object.entries(lang_to_id)) {
    if (logits.data[id] > bestScore) {
      bestScore = logits.data[id];
      bestLanguage = token.slice(2, -2);
    }
  }
  if (!bestLanguage) throw new Error("No Whisper language token was predicted");
  return bestLanguage;
}

self.onmessage = async ({ data: { audio, language } }) => {
  try {
    if (!model) {
      self.postMessage({ progress: "Загружаем модель Whisper…" });
      const transformers = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js");
      const { env, pipeline } = transformers;
      Tensor = transformers.Tensor;
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      model = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", {
        device: "wasm", dtype: "q8",
      });
    }
    if (!language || language === "multi") {
      self.postMessage({ progress: "Определяем язык записи…" });
      language = await detectLanguage(audio);
    }
    self.postMessage({ progress: "Распознаём запись…" });
    const result = await model(audio, { chunk_length_s: 25, stride_length_s: 4, task: "transcribe", language });
    self.postMessage({ text: result.text.replace(/\s+/g, " ").trim(), language });
  } catch (error) {
    console.error(error);
    self.postMessage({ error: "Whisper не смог обработать запись. Проверь интернет для загрузки модели и попробуй ещё раз." });
  }
};
