# Техническое Задание (ТЗ): 1.5 / 3.6 Сервис Уведомлений (NotificationService)

**Эпик:** 1. 🏗️ Ядро Проекта / 3. 🔌 Core-Сервисы **Задача:** 1.5 / 3.6 Сервис Уведомлений (NotificationService) **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать `NotificationService` (Singleton) для отказоустойчивой отправки PUSH-уведомлений (через Telegram) о штатных и критических событиях. Сервис _обязан_ уметь по запросу (`includeAccountState`) прикреплять к сообщению сводку о текущем состоянии портфеля.

## 2\. Архитектурное Решение

1.  **Отказоустойчивость (Критично):** Этот сервис _не должен_ "падать" или "ронять" приложение, если API Telegram недоступно. Он _обязан_ быть полностью асинхронным.
2.  **Очередь (Rate Limiting):** Telegram имеет строгие лимиты на отправку. `NotificationService` _не должен_ отправлять сообщения напрямую. Он _обязан_ реализовать `in-memory` **очередь задач** (`messageQueue`) и **обработчик очереди** (`processQueue`), который отправляет сообщения по одному, с принудительной задержкой (минимум `2000ms` между сообщениями). Сервис также должен отслеживать время последнего сообщения (`lastMessageTime`) и обрабатывать ошибки rate limiting (429) с автоматическим повтором после ожидания.
3.  **Безопасность (Markdown/HTML):** API Telegram (MarkdownV2 и HTML) "сломается", если в тексте (например, в PnL `-10.5` или в ID `123.456`) встретятся спецсимволы. Сервис _обязан_ реализовать helpers `_escapeMarkdown()` и `_escapeHtml()`, которые "экранируют" _весь_ текст перед отправкой. Для сообщений с `AccountState` используется HTML формат для поддержки цветового форматирования.
4.  **Длинные сообщения:** Telegram имеет лимит в 4096 символов на сообщение. Сервис _обязан_ автоматически разбивать длинные сообщения на части (`_splitMessage()`) и отправлять их последовательно с индикацией части (например, "(часть 1/3)").
5.  **Обрезка текста:** Для предотвращения переполнения сообщений, сервис должен обрезать длинные тексты (например, обоснование LLM) до разумной длины (`_truncateText()`).
6.  **Циклические Зависимости:** `NotificationService` зависит от нескольких сервисов (`AccountStateService`, `DatabaseService`, `ExchangeService`, `ExchangeRulesService`), которые также могут зависеть от `NotificationService`.
    - **Решение:** Мы _обязаны_ разорвать этот цикл. `NotificationService` _не будет_ принимать эти сервисы в конструкторе. Вместо этого он _обязан_ предоставить публичные методы инъекции: `injectAccountStateService()`, `injectDatabaseService()`, `injectExchangeService()`, `injectExchangeRulesService()`, которые будут вызваны в `index.ts` _после_ создания всех сервисов.

## 3\. Зависимости Задачи

### 3.1. Зависимости NPM (Новые)

1.  **Логика:** Разработчик _обязан_ установить `node-telegram-bot-api` и его типы.
2.  **Нюанс реализации:**

        npm install node-telegram-bot-api
        npm install -D @types/node-telegram-bot-api

### 3.2. Внутренние Зависимости (DI)

- `ConfigService` (1.3): (В конструктор) Для `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `getWatchlist()`.
- `LoggingService` (1.4): (В конструктор) Для логирования.
- `AccountStateService` (4.5): (Через `injectAccountStateService`) Для `getAccountState()`.
- `DatabaseService` (2.1): (Через `injectDatabaseService`) Для получения торговой статистики и комиссий позиций.
- `ExchangeService` (3.1): (Через `injectExchangeService`) Для получения текущих цен пар.
- `ExchangeRulesService` (3.2): (Через `injectExchangeRulesService`) Для получения комиссий биржи.

## 4\. Описание и Нюансы Реализации

### 4.1. Создание Файла и Класса

1.  **Логика:** Разработчик _обязан_ создать `src/services/NotificationService.ts`.
2.  **Нюанс реализации:** Класс _обязан_ реализовывать паттерн `Singleton` (`private static instance: NotificationService | undefined`, `private constructor`, `public static getInstance(configService: ConfigService)`). Метод `getInstance` принимает `ConfigService` для создания экземпляра при первом вызове.

### 4.2. Конструктор и Инициализация

1.  **Логика:** Конструктор _обязан_ получить `ConfigService`.
2.  **Нюанс реализации:**
    - Сохранить `this.configService = configService`.
    - Получить логгер: `this.logger = LoggingService.getInstance().getLogger('Notification')`.
    - Прочитать `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` через `configService.getTelegramConfig()`.
    - Инициализировать поля: `this.accountStateService = null`, `this.databaseService = null`, `this.exchangeService = null`, `this.exchangeRulesService = null`, `this.bot = null`, `this.chatId = null`, `this.isEnabled = false`, `this.messageQueue = []`, `this.isProcessingQueue = false`, `this.lastMessageTime = 0`, `this.minDelayBetweenMessages = 2000`.
    - Если _оба_ значения присутствуют, `NotificationService` _обязан_:
      1.  Установить `this.isEnabled = true` и `this.chatId = chatId`.
      2.  Инициализировать `this.bot = new TelegramBot(token, { polling: false })` в `try/catch`. (Критично: `polling: false`, мы используем его только для _отправки_).
      3.  При ошибке инициализации установить `this.isEnabled = false` и залогировать ошибку.
      4.  Если успешно, вызвать `this.processQueue().catch(...)` (чтобы запустить обработчик очереди асинхронно).
      5.  Залогировать `info` ("Telegram bot initialized. Notifications enabled.").

    - Если _хотя бы одно_ значение отсутствует:
      1.  Установить `this.isEnabled = false`.
      2.  Залогировать `warn` ("Сервис уведомлений отключен: TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не установлены.").
      3.  _Не_ создавать `TelegramBot` и _не_ вызывать `processQueue()`.

### 4.3. Инъекция Зависимостей (Разрыв Цикла)

1.  **Логика:** Разработчик _обязан_ реализовать публичные методы инъекции для всех зависимостей:
    - `injectAccountStateService(accountStateService: AccountStateService): void`
    - `injectDatabaseService(databaseService: DatabaseService): void`
    - `injectExchangeService(exchangeService: IExchangeService): void`
    - `injectExchangeRulesService(exchangeRulesService: ExchangeRulesService): void`
2.  **Нюанс реализации:** Каждый метод просто сохраняет сервис в соответствующее приватное поле и логирует `debug` ("ServiceName injected.").

### 4.4. Логика Отправки (Метод `sendAlert`)

1.  **Логика:** Разработчик _обязан_ реализовать `public sendAlert(message: string, includeAccountState: boolean = false): void`.
2.  **Нюанс реализации:**
    - Метод _обязан_ быть **синхронным** (`void`).
    - Он _обязан_ немедленно вернуть `void`, если `!this.isEnabled`.
    - Он **не должен** вызывать `this.bot.sendMessage` напрямую.
    - Он _обязан_ создать _асинхронную функцию_ (`async () => { ... }`), которая инкапсулирует _всю_ логику отправки.
    - **Обработка длинных сообщений:** Если сообщение содержит "🤖 Обоснование LLM:", обрезать обоснование до 2000 символов через `_truncateText()`.
    - **Экранирование:** Экранировать сообщение через `_escapeMarkdown()`.
    - **AccountState:** Если `includeAccountState === true` и `this.accountStateService` доступен, вызвать `getAccountState()` и отформатировать через `_formatAccountState()` (асинхронно). Использовать HTML формат (`parse_mode: 'HTML'`) для сообщений с AccountState, иначе MarkdownV2.
    - **Разбиение:** Разбить полное сообщение на части через `_splitMessage()` (максимум 4000 символов на часть).
    - **Отправка:** Отправить каждую часть через `_sendMessageWithRetry()` с задержкой 500ms между частями.
    - Он _обязан_ добавить эту функцию в `private this.messageQueue.push(...)`.
    - Он _обязан_ вызвать `this.processQueue().catch(...)` (на случай, если обработчик "спал").

### 4.5. Логика Очереди (Метод `processQueue`)

1.  **Логика:** Разработчик _обязан_ реализовать `private async processQueue(): Promise<void>`.
2.  **Нюанс реализации (Критично):**
    - Использовать `isProcessingQueue` (boolean-флаг) для предотвращения _параллельного_ запуска `processQueue`. Если флаг уже установлен, немедленно вернуться.
    - Установить `this.isProcessingQueue = true` в начале.
    - Использовать цикл `while (this.messageQueue.length > 0)` внутри `try/finally`.
    - Внутри цикла:
      1.  `const task = this.messageQueue.shift()` (взять задачу).
      2.  `if (!task) continue`.
      3.  **(Критично)** `try { await task(); } catch (error) { this.logger.error(...) }` (Ошибка в одной задаче _не должна_ останавливать всю очередь).
      4.  **(Критично)** Пауза для избежания Rate Limit: если в очереди еще есть задачи, проверить время с последнего сообщения (`Date.now() - this.lastMessageTime`). Если прошло меньше `minDelayBetweenMessages` (2000ms), подождать недостающее время.
    - В блоке `finally` установить `this.isProcessingQueue = false`.

### 4.6. Отправка с Повтором (Метод `_sendMessageWithRetry`)

1.  **Логика:** Разработчик _обязан_ реализовать `private async _sendMessageWithRetry(chatId: string, text: string, options: { parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown' }): Promise<void>`.
2.  **Нюанс реализации:**
    - Реализовать механизм повторов с максимумом 3 попыток.
    - Перед каждой попыткой проверить время с последнего сообщения и подождать, если необходимо.
    - При успешной отправке обновить `this.lastMessageTime = Date.now()`.
    - При ошибке rate limiting (код `ETELEGRAM`, статус 429) извлечь `retry_after` через `_extractRetryAfter()` и подождать указанное время перед повтором.
    - Для других ошибок пробросить исключение после исчерпания попыток.

### 4.7. Извлечение Retry After (Метод `_extractRetryAfter`)

1.  **Логика:** Разработчик _обязан_ реализовать `private _extractRetryAfter(error: unknown): number`.
2.  **Нюанс реализации:**
    - Пытаться извлечь `retry_after` из `error.response.body.parameters.retry_after` или `error.response.parameters.retry_after`.
    - Если не найдено, искать в тексте сообщения ошибки паттерн "retry after X".
    - Возвращать время в миллисекундах или дефолтное значение (`minDelayBetweenMessages * 2` = 4000ms).

### 4.8. Хелперы Форматирования

1.  **Логика:** Разработчик _обязан_ реализовать следующие хелперы:
    - `private _escapeMarkdown(text: string): string` - экранирование для MarkdownV2
    - `private _escapeHtml(text: string): string` - экранирование для HTML (`&`, `<`, `>`)
    - `private _truncateText(text: string, maxLength: number): string` - обрезка текста с сохранением целых слов
    - `private _splitMessage(message: string, maxLength: number = 4000): string[]` - разбиение длинных сообщений на части
    - `private async _formatAccountState(state: AccountState): Promise<string>` - форматирование состояния портфеля в HTML

2.  **Нюанс реализации (`_escapeMarkdown`):**
    - Этот метод _обязан_ "экранировать" (добавлять `\`) _все_ спецсимволы, требуемые Telegram: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`.
    - Использовать регулярное выражение: `text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1')`.

3.  **Нюанс реализации (`_formatAccountState`):**
    - Метод должен быть **асинхронным** (возвращает `Promise<string>`), так как получает данные из БД и Exchange API.
    - Форматировать в HTML формате для поддержки цветового форматирования.
    - Выводить: общую стоимость портфеля, доступный баланс, валюты из watchlist, открытые позиции с расчетом unrealized PnL, открытые ордера.
    - Для позиций: получать комиссию входа из БД, текущую цену из Exchange API, комиссию биржи из ExchangeRulesService, рассчитывать unrealized PnL с учетом комиссий.
    - Использовать `_escapeHtml()` для всех динамических данных.
    - Показывать только отслеживаемые валюты из watchlist (через `configService.getWatchlist()`).

### 4.9. Дополнительные Методы Отправки

1.  **Метод `sendTradingSummary`:** 
    - `public sendTradingSummary(action: string, pair: string, justification: string): void`
    - Отправляет сводку о выполненной сделке с обоснованием LLM и торговой статистикой.
    - Получает статистику из БД через `_getTradingSummary()` и форматирует через `_formatTradingSummary()`.
    - Обрезает обоснование LLM до 2000 символов.

2.  **Метод `sendTriggersUpdate`:**
    - `public sendTriggersUpdate(pair: string, reason: string, triggerConditions: Array<...>, requestedData: string[] | null, updatedAt: Date): void`
    - Отправляет уведомление об установке/обновлении триггеров для пары.
    - Форматирует через `_formatTriggersUpdate()`.

3.  **Метод `_getTradingSummary`:**
    - `private async _getTradingSummary(): Promise<{...}>`
    - Получает торговую статистику из БД: общее количество сделок, закрытых позиций, общий PnL, комиссии, win rate, средний профит/убыток, открытые позиции с unrealized PnL.

4.  **Метод `_formatTradingSummary`:**
    - `private _formatTradingSummary(summary: {...}): string`
    - Форматирует торговую статистику в MarkdownV2 формат для Telegram.

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

    `processQueue` проверяет время с последнего сообщения и вставляет паузу (минимум `2000ms`) между отправками, если необходимо.

9.  Robustness

    `processQueue` _оборачивает_ `await task()` в `try/catch` (ошибка API не ломает очередь).

10. Format(Критично)


    Реализован `_escapeMarkdown()`, который экранирует _все_ спецсимволы Telegram (включая `.` и `!`).

11. Logic


    `sendAlert` (при `includeAccountState: true`) _корректно_ вызывает `accountStateService.getAccountState()` и `_formatAccountState()`.

12. Logic

    `_formatAccountState` _корректно_ форматирует PnL, активы и позиции, используя `_escapeHtml` и HTML формат. Метод асинхронно получает данные из БД и Exchange API для расчета unrealized PnL.

13. DI

    Сервис _корректно_ инъектирует все зависимости через методы `injectAccountStateService()`, `injectDatabaseService()`, `injectExchangeService()`, `injectExchangeRulesService()`.

14. Retry

    Метод `_sendMessageWithRetry` _корректно_ обрабатывает ошибки rate limiting (429) с автоматическим повтором после ожидания времени из `retry_after`.

15. Long Messages

    Длинные сообщения (>4000 символов) _автоматически_ разбиваются на части через `_splitMessage()` и отправляются последовательно с индикацией части.

16. Text Truncation

    Длинные тексты (например, обоснование LLM) _автоматически_ обрезаются через `_truncateText()` для предотвращения переполнения сообщений.

17. Trading Summary

    Метод `sendTradingSummary` _корректно_ отправляет сводку о сделке с торговой статистикой из БД.

18. Triggers Update

    Метод `sendTriggersUpdate` _корректно_ отправляет уведомления об установке/обновлении триггеров.
