# Техническое Задание (ТЗ): 1.1 Инициализация TypeScript-проекта

**Эпик:** 1. 🏗️ Ядро Проекта, Окружение и TypeScript (Core Project & Environment) **Задача:** 1.1 Инициализация TypeScript-проекта **Архитектор:** Gemini **Дата:** 29.10.2025

## 1\. Цель Задачи

Создать и сконфигурировать "скелет" (scaffolding) Node.js проекта на TypeScript. Эта задача закладывает фундамент для всего приложения, обеспечивая строгость типизации, единый стиль кода и автоматизацию рутинных проверок.

## 2\. Описание и Нюансы Реализации

Разработчик должен инициализировать проект и настроить следующие инструменты, уделяя особое внимание их взаимной интеграции.

### 2.1. `package.json`

- Инициализировать `npm` проект (`npm init -y` или аналогичный).
- **Критический нюанс:** Установить `"type": "module"` в `package.json`. Это включает режим ES Modules для всего проекта.
- Установить `devDependencies`:
  - `typescript`
  - `@types/node` (указать версию, соответствующую Node 20, например `@types/node: "^20.0.0"`)
  - `eslint`
  - `@typescript-eslint/parser` (для парсинга TS-кода)
  - `@typescript-eslint/eslint-plugin` (для набора TS-правил)
  - `eslint-config-prettier` (для **отключения** правил ESLint, конфликтующих с Prettier)
  - `prettier`
  - `tsx` (для запуска TS "на лету" в режиме разработки, как более современная альтернатива `ts-node`)
  - `knip` (для проверки неиспользуемого кода, используется в скрипте `check:unused`)

### 2.2. `tsconfig.json`

- Создать файл `tsconfig.json`.
- **Нюанс:** Файл должен быть сконфигурирован для максимальной строгости ("строгий контроль качества кода").
- Обязательные ключевые параметры в `compilerOptions`:
  - `"strict": true` (Включает все строгие проверки типов: `noImplicitAny`, `strictNullChecks` и т.д.)
  - `"target": "ES2022"` (Компиляция в современный JS, поддерживаемый Node 20)
  - `"module": "NodeNext"` (Система модулей, совместимая с ESM в Node.js)
  - `"moduleResolution": "NodeNext"` (Алгоритм разрешения модулей, обязателен для `NodeNext`)
  - `"esModuleInterop": true` (Обеспечивает совместимость `import` с `require` для старых библиотек)
  - `"allowSyntheticDefaultImports": true` (Разрешает импорт по умолчанию из модулей без экспорта по умолчанию)
  - `"skipLibCheck": true` (Ускоряет компиляцию, пропуская проверку `.d.ts` файлов)
  - `"forceConsistentCasingInFileNames": true` (Предотвращает ошибки на case-sensitive файловых системах)
  - `"noUncheckedIndexedAccess": true` (Дополнительная строгость: доступ к элементу массива/объекта по индексу/ключу считается `T | undefined`)
  - `"outDir": "./dist"` (Куда компилировать JS)
  - `"rootDir": "./src"` (Где лежат исходные TS-файлы)
- Дополнительно должны быть настроены:
  - `"include": ["src/**/*"]` (Включать все файлы из директории `src`)
  - `"exclude": ["node_modules", "dist"]` (Исключать из компиляции)

### 2.3. ESLint (Конфигурация `.eslintrc.cjs`)

- Настроить ESLint для работы с TypeScript и Prettier.
- **Критический нюанс:** Файл должен иметь расширение `.cjs` (CommonJS), т.к. проект использует `"type": "module"` в `package.json`. Это позволяет ESLint корректно работать в ESM-окружении.
- **Нюанс:** Порядок расширений (extends) критически важен.
- Обязательные параметры:
  - `parser: '@typescript-eslint/parser'`
  - `extends`:
    1.  `'eslint:recommended'`
    2.  `'plugin:@typescript-eslint/recommended'`
    3.  `'prettier'` (**Обязательно** должен быть последним, чтобы отключить конфликтующие правила)

  - `plugins: ['@typescript-eslint']` (используется плагин без суффикса `/plugin`)
  - `parserOptions`:
    - `ecmaVersion: 2022`
    - `sourceType: 'module'`
  - `env`:
    - `node: true`
    - `es2022: true`
  - В `rules` добавить:
    - `"@typescript-eslint/no-explicit-any": "error"` (Запрет `any` для повышения строгости)
    - `"@typescript-eslint/no-unused-vars": "warn"` (Подсвечивать неиспользуемые переменные)

### 2.4. Prettier (Конфигурация `.prettierrc`)

- Создать файл `.prettierrc` для фиксации стиля кода.
- Рекомендуемые правила:
  - `"singleQuote": true`
  - `"trailingComma": "all"`
  - `"semi": true`
  - `"printWidth": 120` (Современный стандарт ширины строки)

### 2.5. Структура Папок и Файлов

- Создать базовую структуру:

      /
      ├── src/
      │   └── index.ts  (Создать с `console.log('Service starting...')`)
      ├── .eslintignore
      ├── .gitignore
      ├── .prettierrc
      ├── .eslintrc.cjs
      ├── package.json
      ├── tsconfig.json

### 2.6. `.gitignore` и `.eslintignore`

- В `.gitignore` обязательно добавить:
  - `node_modules/`
  - `dist/`
  - `.env*` (включая `.env.local`, `.env.*.local`)
  - `*.log`
  - `logs/` (директория для лог-файлов, создаваемая LoggingService)

- В `.eslintignore` добавить:
  - `dist/`
  - `node_modules/`

### 2.7. `npm` скрипты (в `package.json`)

- Определить следующие базовые скрипты:
  - `"build"`: `"tsc"` (Компиляция проекта)
  - `"typecheck"`: `"tsc --noEmit"` (Проверка типов без генерации файлов)
  - `"start:prod"`: `"node dist/index.js"` (Запуск скомпилированной версии)
  - `"dev"`: `"tsx watch src/index.ts"` (Запуск в режиме разработки с автоперезагрузкой)
  - `"lint"`: `"eslint . --ext .ts"` (Проверка кода линтером)
  - `"lint:fix"`: `"eslint . --ext .ts --fix"` (Автоматическое исправление ошибок линтера)
  - `"format:check"`: `"prettier --check ."` (Проверка форматирования)
  - `"format"`: `"prettier --write ."` (Автоматическое форматирование)
  - `"check:unused"`: `"knip"` (Проверка неиспользуемого кода через knip)
  - `"check:all"`: `"npm run typecheck && npm run lint && npm run format:check"` (Комплексная проверка: типы, линтер, форматирование)

**Примечание:** Дополнительные скрипты для тестирования, миграций БД и утилит добавляются в последующих задачах.

## 3\. Критерии Приемки (Acceptance Criteria)

Задача считается выполненной, если:

1.  **\[Структура\]** Все файлы и директории из п. 2.5 созданы.
2.  **\[Установка\]** `npm install` (или `yarn install`) завершается успешно без ошибок.
3.  **\[Компиляция\]** `npm run build` успешно компилирует `src/index.ts` в `dist/index.js`.
4.  **\[Запуск\]** `npm run start:prod` выводит в консоль "Service starting...".
5.  **\[Разработка\]** `npm run dev` запускает `src/index.ts`, выводит "Service starting..." и перезапускается при внесении изменений в `index.ts`.
6.  **\[Форматирование\]** `npm run format:check` завершается успешно (код `0`) на чистом проекте.
7.  **\[Линтинг\]** `npm run lint` завершается успешно (код `0`) на чистом проекте.
8.  **\[Конфликт-Тест 1 (Линтер)\]** При добавлении `let a: any = 1;` в `src/index.ts`, `npm run lint` должен завершиться с ошибкой (из-за правила `no-explicit-any`).
9.  **\[Конфликт-Тест 2 (Prettier)\]** При добавлении `const text = "double quote";` (нарушение Prettier) в `src/index.ts`:
    - `npm run lint` **не** должен сообщать об этой ошибке (т.к. `eslint-config-prettier` отключил правило кавычек).
    - `npm run format:check` **должен** завершиться с ошибкой.
    - `npm run format` исправляет кавычки на одинарные.

10. **\[Игнорирование\]** Файлы в `dist/` и `node_modules/` игнорируются при запуске `npm run lint`.

11. **\[Git\]** Файл `.gitignore` присутствует и корректно настроен (папки `node_modules/`, `dist/` и `.env` не отслеживаются Git).
