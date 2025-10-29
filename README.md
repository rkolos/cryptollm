# CryptoLLM - LLM-Powered Cryptocurrency Trading Bot

Интеллектуальный торговый бот для криптовалют на основе LLM.

## Требования

- Node.js 20+
- Docker и Docker Compose
- PostgreSQL 15+

## Быстрый старт

1. Установите зависимости:

```bash
npm install
```

2. Настройте переменные окружения:

```bash
cp .env.example .env
# Отредактируйте .env файл с вашими настройками
```

3. Запустите PostgreSQL в Docker:

```bash
docker-compose up -d postgres
```

4. Запустите проект в режиме разработки:

```bash
npm run dev
```

## Команды

- `npm run build` - компиляция TypeScript
- `npm run start:prod` - запуск скомпилированной версии
- `npm run dev` - запуск в режиме разработки с автоперезагрузкой
- `npm run lint` - проверка кода линтером
- `npm run lint:fix` - автоматическое исправление ошибок линтера
- `npm run format:check` - проверка форматирования
- `npm run format` - автоматическое форматирование кода

## Структура проекта

```
/
├── src/              # Исходный код TypeScript
├── dist/             # Скомпилированный JavaScript
├── migrations/       # Миграции базы данных
├── docker-compose.yml
├── .env.example      # Шаблон переменных окружения
└── package.json
```
