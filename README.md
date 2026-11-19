# Голосовые заметки

[Открыть сайт](https://lubyek.github.io/voice-notes-local/). Разреши доступ к микрофону и начни запись. После остановки запись отправляется в ProxyAPI на расшифровку моделью [AssemblyAI Universal‑3.6 Pro](https://proxyapi.ru/models/assemblyai/universal-3-6-pro). Язык определяется автоматически. При необходимости выбери его вручную.

На GitHub Pages запросы идут через Cloudflare Worker. Ключ ProxyAPI хранится в секретах Worker. История расшифровок хранится в браузере.

## Локальный запуск

```bash
read -r -s -p 'Ключ ProxyAPI: ' PROXYAPI_API_KEY
export PROXYAPI_API_KEY
python app.py
```

Открой http://localhost:8765. При локальном запуске ключ использует сервер, а история хранится в SQLite.

GitHub Pages публикует папку `/docs` из ветки `main`.


## Публикация обработчика

Установи зависимости через `npm ci`. Собери обработчик через `npm run build` и проверь его командой `npx cf deploy --prebuilt --dry-run`. Для публикации войди через `npx cf auth login` и передай `PROXYAPI_API_KEY` через `npx cf deploy --prebuilt --secrets-file <закрытый-файл>`. Запиши URL опубликованного Worker с путём `/transcribe` в `docs/service-config.js`.

Обработчик принимает аудио с сайта `https://lubyek.github.io` и передаёт его только в модель `assemblyai/universal-3-6-pro`. Cloudflare ограничивает частоту запросов по IP и на уровне точки присутствия.
