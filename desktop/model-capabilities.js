import catalog from "../docs/models.json" with { type: "json" };

export const speechModels = new Map(catalog);
export const defaultSpeechModel = catalog[0][0];

const assembly = "https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels";
const assemblyLimits = "https://www.assemblyai.com/blog/which-assemblyai-stt-3-7-model";
const deepgram = "https://developers.deepgram.com/docs/models-languages-overview";
const eleven = "https://elevenlabs.io/docs/overview/capabilities/speech-to-text";
const fish = "https://docs.fish.audio/features/speech-to-text";
const mistral = "https://docs.mistral.ai/studio/audio/specs-and-limits/languages";
const mistralBatch = "https://docs.mistral.ai/inference/batch-processing";
const qwen = "https://github.com/QwenLM/Qwen3-ASR#overview";
const nvidia = "https://docs.nvidia.com/nemo/speech/nightly/asr/featured_models.html";
const openaiFiles = "https://developers.openai.com/api/docs/guides/speech-to-text";
const openaiLive = "https://developers.openai.com/api/reference/resources/realtime/subresources/transcription_sessions/methods/create";
const openaiLegacy = "Нативный API OpenAI объявлен устаревшим. Доступность через ProxyAPI зависит от его каталога и маршрута.";
const unspecified = "Не заявлено";
const missingCount = "Нет данных";

const scribe = {
  languages: "90+", realtime: "Нет", channels: "До 5", parallel: "Да · API",
  note: "Scribe v2 Realtime — отдельная модель. Нативный пакетный API также умеет обрабатывать длинные файлы параллельно.",
  sources: [eleven, "https://elevenlabs.io/insights/speech-to-text-api-integration"],
};
const fishBase = {
  languages: missingCount, realtime: "Нет", channels: unspecified, parallel: "Да · API",
  note: "Fish Audio указывает автоопределение языка без полного перечня. Нативный ASR принимает готовый файл.",
  sources: [fish, "https://fish.audio/text-to-speech-api/"],
};
const voxtral3 = {
  languages: "53", realtime: "Нет", channels: unspecified, parallel: "Да · пакетный API",
  note: "Для живого потока Mistral предлагает отдельный Voxtral Mini Transcribe Realtime 3.",
  sources: [mistral, mistralBatch],
};
const voxtral2507 = {
  languages: "8", realtime: "Нет", channels: unspecified, parallel: "Да · vLLM",
  note: "Восемь языков указаны в карточке исходной модели. vLLM поддерживает обработку отдельных запросов пакетами.",
};
const qwen3 = {
  languages: "30 + 22 диалекта", realtime: "Да", channels: "Нет · моно", parallel: "Да · vLLM",
  note: "Обе версии Qwen3-ASR работают в потоковом и файловом режимах. 22 диалекта относятся к китайскому.",
  sources: [qwen],
};
const gpt4o = {
  languages: missingCount, realtime: "Да", channels: "Нет · моно", parallel: "Да · API",
  note: "OpenAI не публикует точное число языков для этой модели. " + openaiLegacy,
  sources: [openaiFiles, openaiLive],
};
const whisperV3 = {
  languages: "99", realtime: "Нет", channels: "Нет · моно", parallel: "Да · при развёртывании",
  note: "Нативная модель принимает готовые фрагменты. Сервисы могут поверх неё обрабатывать пакеты записей.",
};

export const modelCapabilities = {
  "x-ai/grok-stt-2.0": {
    languages: "38+", realtime: "Да", channels: "2–8", parallel: "Да · 100 сеансов",
    note: "xAI поддерживает раздельную обработку каналов в потоковом режиме. Лимит сеансов относится к нативному API для команды.",
    sources: ["https://docs.x.ai/developers/model-capabilities/audio/speech-to-text", "https://docs.x.ai/developers/models/speech-to-text"],
  },
  "assemblyai/universal-3-6-pro": {
    languages: "32 · Realtime", realtime: "Да", channels: "По сеансу на канал", parallel: "Да · API",
    note: "32 языка подтверждены для Realtime. AssemblyAI описывает отдельный сеанс для каждого канала живого аудио.",
    sources: ["https://www.assemblyai.com/blog/universal-3-6-pro-realtime-supported-languages", assembly, assemblyLimits],
  },
  "assemblyai/universal-3-5-pro": {
    languages: "18", realtime: "Да", channels: "Да · файлы", parallel: "Да · API",
    note: "18 языков у модели, без учёта запасного Universal-2. Для Realtime каждый канал подаётся отдельным сеансом. AssemblyAI объявила модель устаревшей.",
    sources: ["https://www.assemblyai.com/blog/universal-3-5-pro-code-switching-contextual-prompting", assembly, assemblyLimits],
  },
  "deepgram/nova-3": {
    languages: "95 кодов · 55 в смешанном", realtime: "Да", channels: "Да", parallel: "Да · API",
    note: "В таблице одноязычных режимов 95 базовых кодов без подсчёта региональных вариантов. 55 языков доступны с переключением внутри разговора.",
    sources: [deepgram, "https://developers.deepgram.com/changelog/2026/10/23", "https://developers.deepgram.com/docs/stt-streaming-feature-overview"],
  },
  "elevenlabs/scribe-v2": scribe,
  "elevenlabs/scribe-v2-medical": {
    ...scribe, note: "Файловая модель с медицинским словарём. ElevenLabs указывает те же языки, функции и API, что у обычной Scribe v2.",
    sources: ["https://elevenlabs.io/medical-transcription", ...scribe.sources],
  },
  "fish-audio/transcribe-1-pro": fishBase,
  "fish-audio/transcribe-1": fishBase,
  "meta/muse-voice-transcribe-1.0": {
    languages: "25", realtime: "Да", channels: "Нет · моно", parallel: "Да · 256 сеансов",
    note: "Прямой API Meta принимает моно в Realtime. Файловые и потоковые запросы используют общий лимит команды.",
    sources: ["https://dev.meta.ai/docs/speech-to-text", "https://dev.meta.ai/docs/pricing-rate-limits"],
  },
  "mistralai/voxtral-mini-transcribe-3-0": voxtral3,
  "mistralai/voxtral-small-transcribe-3-0": voxtral3,
  "mistralai/voxtral-mini-3b-2507": {
    ...voxtral2507, sources: ["https://huggingface.co/mistralai/Voxtral-Mini-3B-2507"],
  },
  "mistralai/voxtral-small-24b-2507-stt": {
    ...voxtral2507, sources: ["https://huggingface.co/mistralai/Voxtral-Small-24B-2507"],
  },
  "mistralai/voxtral-mini-transcribe": {
    languages: missingCount, realtime: "Нет", channels: unspecified, parallel: unspecified,
    note: "Для этого идентификатора опубликован файловый API. Точная версия Voxtral Mini и число её языков не указаны.",
    sources: ["https://openrouter.ai/mistralai/voxtral-mini-transcribe"],
  },
  "moondream/parakeet-ultra": {
    languages: "25", realtime: unspecified, channels: unspecified, parallel: unspecified,
    note: "Moondream описывает обработку записей с автоматической нарезкой по паузам. Поддержка живой сессии не заявлена.",
    sources: ["https://moondream.ai/blog/introducing-parakeet-redux-and-ultra"],
  },
  "nvidia/nemotron-3.5-transcribe": {
    languages: "40", realtime: "Нет", channels: unspecified, parallel: "Да · vLLM",
    note: "NVIDIA описывает обработку готовых записей и маркировку говорящих. Маркировка говорящих в одной записи отличается от обработки отдельных каналов.",
    sources: ["https://docs.nvidia.com/nemo/speech/nightly/speechlm2/nemotron_transcribe.html"],
  },
  "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b": {
    languages: "32 локали", realtime: "Да", channels: "Нет · моно", parallel: "Да · GPU",
    note: "19 локалей с лучшей точностью и 13 с расширенным покрытием. Ещё для 8 локалей NVIDIA указывает необходимость дообучения.",
    sources: ["https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b", nvidia],
  },
  "nvidia/parakeet-tdt-0.6b-v3": {
    languages: "25", realtime: "Нет · файловая модель", channels: "Нет · моно", parallel: "Да · NeMo",
    note: "При развёртывании NVIDIA поддерживает пакетную обработку. Для нативного потокового режима используется отдельная модель.",
    sources: ["https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3", nvidia],
  },
  "openai/gpt-4o-transcribe-diarize": {
    ...gpt4o, realtime: "Указан в API¹",
    note: "¹ Модель указана среди вариантов Realtime-сессии. OpenAI документирует метки говорящих только для файлового режима. " + openaiLegacy,
  },
  "openai/gpt-4o-mini-transcribe": gpt4o,
  "openai/gpt-4o-transcribe": gpt4o,
  "openai/whisper-large-v3": {
    ...whisperV3, sources: ["https://huggingface.co/openai/whisper-large-v3", "https://github.com/openai/whisper"],
  },
  "openai/whisper-large-v3-turbo": {
    ...whisperV3, sources: ["https://huggingface.co/openai/whisper-large-v3-turbo", "https://github.com/openai/whisper"],
  },
  "openai/whisper-1": {
    languages: "98", realtime: "По окончании реплики", channels: "Нет · моно", parallel: "Да · API",
    note: "В Realtime-сессии Whisper отдаёт готовую реплику целиком. " + openaiLegacy,
    sources: [openaiFiles, openaiLive],
  },
  "qwen/qwen3-asr-0.6b": qwen3,
  "qwen/qwen3-asr-1.7b": qwen3,
};

export const capabilityColumns = [
  ["languages", "Языки"],
  ["realtime", "Нативный Realtime"],
  ["channels", "Раздельные каналы"],
  ["parallel", "Параллельная обработка"],
];
