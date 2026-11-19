# Голосовые заметки

[Открыть сайт](https://lubyek.github.io/voice-notes-local/). Выбери модель из [каталога распознавания ProxyAPI](https://proxyapi.ru/models/browse/stt) и разреши доступ к микрофону. Язык по умолчанию определяется автоматически. После записи текст можно скопировать, найти в истории или удалить вместе с другими расшифровками кнопкой «Очистить».

На GitHub Pages после подключения Cloudflare Worker ключ используется только на сервере. До подключения публичная страница использует ключ, введённый на время вкладки. История хранится в браузере.

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

Обработчик принимает аудио с сайта `https://lubyek.github.io` и передаёт его в выбранную модель распознавания из `docs/models.json`. Cloudflare ограничивает частоту запросов по IP и на уровне точки присутствия.
