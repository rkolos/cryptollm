# Настройка MCP сервера PostgreSQL для Cursor

## Автоматическая настройка

Файл `.cursor/mcp.json` уже создан и настроен. Cursor должен автоматически подхватить конфигурацию при следующем запуске.

## Ручная настройка в Cursor (если автоматическая не работает)

Если автоматическая настройка не сработала, выполните следующие шаги:

1. Откройте настройки Cursor:
   - macOS: `Cmd + ,` или `Cursor > Settings`
   - Windows/Linux: `Ctrl + ,` или `File > Preferences > Settings`

2. Найдите раздел "MCP" или "Model Context Protocol" в настройках

3. Добавьте новый MCP сервер со следующими параметрами:
   ```json
   {
     "name": "postgres",
     "command": "npm",
     "args": ["run", "mcp:postgres:server"],
     "cwd": "/Users/user/Documents/SearchDevTeam/MLforex"
   }
   ```
   
   Или используйте относительный путь:
   - **Name**: `postgres`
   - **Command**: `npm`
   - **Args**: `["run", "mcp:postgres:server"]`
   - **Working Directory**: корень проекта (где находится `package.json`)

## Альтернативный способ (прямой запуск скрипта)

Если npm команда не работает, используйте прямой запуск:

- **Command**: `npx`
- **Args**: `["-y", "tsx", "./scripts/mcp-postgres-server.ts"]`
- **Working Directory**: корень проекта

## Проверка работы

После настройки MCP сервер должен автоматически запускаться при использовании Cursor. 
Вы сможете запрашивать информацию из базы данных PostgreSQL через чат Cursor.

Проверить работу можно:
1. Откройте чат в Cursor
2. Попросите Cursor выполнить SQL запрос к базе данных
3. Если MCP настроен правильно, Cursor сможет работать с PostgreSQL

## Переменные окружения

Скрипт автоматически использует переменные окружения из файла `.env`:
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Убедитесь, что файл `.env` существует и содержит правильные значения подключения к PostgreSQL.

## Тестирование скрипта вручную

Вы можете протестировать скрипт напрямую:
```bash
npm run mcp:postgres:server
```

Это должно запустить MCP сервер PostgreSQL. Для остановки нажмите `Ctrl+C`.

