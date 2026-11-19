# Голосовые заметки

[Открыть сайт](https://lubyek.github.io/voice-notes-local/). Введи свой ключ ProxyAPI и разреши доступ к микрофону. После остановки запись отправляется в ProxyAPI на расшифровку моделью [AssemblyAI Universal‑3.6 Pro](https://proxyapi.ru/models/assemblyai/universal-3-6-pro). Язык определяется автоматически. При необходимости выбери его вручную.

Ключ вводится заново после перезагрузки страницы. История расшифровок хранится в браузере.

## Локальный запуск

```bash
read -r -s -p 'Ключ ProxyAPI: ' PROXYAPI_API_KEY
export PROXYAPI_API_KEY
python app.py
```

Открой http://localhost:8765. При локальном запуске ключ использует сервер, а история хранится в SQLite.

GitHub Pages публикует папку `/docs` из ветки `main`.
