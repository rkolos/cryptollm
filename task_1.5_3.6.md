# Техническое Задание (ТЗ): 1.5 / 3.6 Сервис Уведомлений (NotificationService)

**Эпик:** 1. 🏗️ Ядро Проекта / 3. 🔌 Core-Сервисы **Задача:** 1.5 / 3.6 Сервис Уведомлений (NotificationService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `NotificationService` (Singleton) для отказоустойчивой отправки PUSH-уведомлений (через Telegram) о штатных и критических событиях. Сервис _обязан_ уметь по запросу (`includeAccountState`) прикреплять к сообщению сводку о текущем состоянии портфеля.

## 2\. Архитектурное Решение

1.  **Отказоустойчивость (Критично):** Этот сервис _не должен_ "падать" или "ронять" приложение, если API Telegram недоступно. Он _обязан_ быть полностью асинхронным.
2.  **Очередь (Rate Limiting):** Telegram имеет строгие лимиты на отправку. `NotificationService` _не должен_ отправлять сообщения напрямую. Он _обязан_ реализовать `in-memory` **очередь задач** (`messageQueue`) и **обработчик очереди** (`processQueue`), который отправляет сообщения по одному, с принудительной задержкой (`~1100ms`) между ними.
3.  **Безопасность (Markdown):** API Telegram (MarkdownV2) "сломается", если в тексте (например, в PnL `-10.5` или в ID `123.456`) встретятся спецсимволы. Сервис _обязан_ реализовать helper `_escapeMarkdown()`, который "экранирует" _весь_ текст перед отправкой.
4.  **Циклические Зависимости:** `NotificationService` зависит от `AccountStateService` (для получения PnL), а `AccountStateService` (и почти все другие сервисы) зависит от `NotificationService` (для отправки алертов).
    - **Решение:** Мы _обязаны_ разорвать этот цикл. `NotificationService` _не будет_ принимать `AccountStateService` в конструкторе. Вместо этого он _обязан_ предоставить публичный метод `injectAccountStateService(service)`, который будет вызван в `index.ts` (Задача 8.1) _после_ создания _обоих_ сервисов.

## 3\. Зависимости Задачи

### 3.1. Зависимости NPM (Новые)

1.  **Логика:** Разработчик _обязан_ установить `node-telegram-bot-api` и его типы.
2.  **Нюанс реализации:**

        npm install node-telegram-bot-api
        npm install -D @types/node-telegram-bot-api

### 3.2. Внутренние Зависимости (DI)

- `ConfigService` (1.3): (В конструктор) Для `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `LoggingService` (1.4): (В конструктор) Для логирования.
- `AccountStateService` (4.5): (Через `injectAccountStateService`) Для `getAccountState()`.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла и Класса

1.  **Логика:** Разработчик _обязан_ создать `src/services/NotificationService.ts`.
2.  **Нюанс реализации:** Класс _обязан_ реализовывать паттерн `Singleton` (`private static instance`, `private constructor`, `public static getInstance`).

### 4.2. Конструктор и Инициализация

1.  **Логика:** Конструктор _обязан_ получить `ConfigService` и `LoggingService`.
2.  **Нюанс реализации:**
    - Прочитать `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.
    - Если _оба_ значения присутствуют, `NotificationService` _обязан_:
      1.  Установить `this.isEnabled = true`.
      2.  Инициализировать `this.bot = new TelegramBot(token, { polling: false })`. (Критично: `polling: false`, мы используем его только для _отправки_).
      3.  Вызвать `this.processQueue()` (чтобы запустить "прослушку" очереди).
      4.  Залогировать `info`.

    - Если _хотя бы одно_ значение отсутствует:
      1.  Установить `this.isEnabled = false`.
      2.  Залогировать `warn` ("Сервис уведомлений отключен").
      3.  _Не_ создавать `TelegramBot` и _не_ вызывать `processQueue()`.

### 4.3. Инъекция Зависимости (Разрыв Цикла)

1.  **Логика:** Разработчик _обязан_ реализовать публичный метод `injectAccountStateService(accountStateService: AccountStateService)`.
2.  **Нюанс реализации:** Этот метод просто сохраняет сервис в `private this.accountStateService`.

### 4.4. Логика Отправки (Метод `sendAlert`)

1.  **Логика:** Разработчик _обязан_ реализовать `public sendAlert(message: string, includeAccountState: boolean = false): void`.
2.  **Нюанс реализации:**
    - Метод _обязан_ быть **синхронным** (`void`).
    - Он _обязан_ немедленно вернуть `void`, если `!this.isEnabled`.
    - Он **не должен** вызывать `this.bot.sendMessage` напрямую.
    - Он _обязан_ создать _асинхронную функцию_ (`async () => { ... }`), которая инкапсулирует _всю_ логику отправки.
    - Он _обязан_ добавить эту функцию в `private this.messageQueue.push(...)`.
    - Он _обязан_ вызвать `this.processQueue()` (на случай, если обработчик "спал").

### 4.5. Логика Очереди (Метод `processQueue`)

1.  **Логика:** Разработчик _обязан_ реализовать `private async processQueue(): Promise<void>`.
2.  **Нюанс реализации (Критично):**
    - Использовать `isProcessingQueue` (boolean-флаг) для предотвращения _параллельного_ запуска `processQueue`.
    - Использовать цикл `while (this.messageQueue.length > 0)`.
    - Внутри цикла:
      1.  `const task = this.messageQueue.shift()` (взять задачу).
      2.  `if (!task) continue`.
      3.  **(Критично)** `try { await task(); } catch (error) { this.logger.error(...) }` (Ошибка в одной задаче _не должна_ останавливать всю очередь).
      4.  **(Критично)** `await new Promise(resolve => setTimeout(resolve, 1100))` (Пауза для избежания Rate Limit).

### 4.6. Логика "Задачи" (Task Logic)

1.  **Логика:** "Задача" (асинхронная функция, созданная в `sendAlert`) _обязана_ делать следующее:
2.  **Нюанс реализации:**
    - Проверить `includeAccountState` и `this.accountStateService`.
    - Если `true`, вызвать `this.accountStateService.getAccountState()` (синхронно из кэша) и передать результат в `_formatAccountState()`.
    - Сформировать `fullMessage`.
    - **(Критично)** Вызвать `await this.bot.sendMessage(this.chatId, fullMessage, { parse_mode: 'MarkdownV2', ... })`.

### 4.7. Хелперы Форматирования

1.  **Логика:** Разработчик _обязан_ реализовать `private _formatAccountState(state: AccountState)` и `private _escapeMarkdown(text: string)`.
2.  **Нюанс реализации (`_escapeMarkdown`):**
    - Этот метод _обязан_ "экранировать" (добавлять `\`) _все_ спецсимволы, требуемые Telegram (e.g., `_`, `*`, `[`, `]`, `(`, `)`, `~`, `\``,` \>`,` #`,` +`,` \-`,` \=`,` |`,` {`,` }`,` .`,` !\`).
    - `_formatAccountState` _обязан_ вызывать `_escapeMarkdown` для _всех_ динамических данных (цен, имен, PnL) _перед_ добавлением Markdown-разметки (e.g., `*Total Value:* \`${escapedTotalValue}\`\`).

## 5\. Критерии Приемки (Acceptance Criteria)

1.  Deps

    `node-telegram-bot-api` и `@types/node-telegram-bot-api` установлены.

2.  Service

    Создан `NotificationService.ts` (Singleton).

3.  Config

    Сервис корректно читает `TOKEN` и `CHAT_ID`.

4.  Config

    Сервис _корректно_ отключается (`isEnabled = false`) и логирует `warn`, если `TOKEN` или `CHAT_ID` отсутствуют, и _не падает_.

5.  DI(Критично)

    Сервис _корректно_ разрывает цикл зависимостей, используя `injectAccountStateService()`.

6.  Queue(Критично)

    `sendAlert` _добавляет_ задачу в `messageQueue`, а _не_ выполняет ее.

7.  Queue

    `processQueue` _корректно_ обрабатывает очередь по одному (FIFO) с использованием `isProcessingQueue`.

8.  Queue(Критично)

    `processQueue` _вставляет_ паузу (`~1100ms`) между отправками.

9.  Robustness

    `processQueue` _оборачивает_ `await task()` в `try/catch` (ошибка API не ломает очередь).

10. Format(Критично)


    Реализован `_escapeMarkdown()`, который экранирует _все_ спецсимволы Telegram (включая `.` и `!`).

11. Logic


    `sendAlert` (при `includeAccountState: true`) _корректно_ вызывает `accountStateService.getAccountState()` и `_formatAccountState()`.

12. Logic


    `_formatAccountState` _корректно_ форматирует PnL, активы и позиции, используя `_escapeMarkdown`.
