# Рекомендации по инструментам для поиска ошибок

## 🎯 Рекомендуемые инструменты (по приоритету)

### 1. **knip** - Поиск неиспользуемого кода и зависимостей ⭐⭐⭐⭐⭐
**Зачем:** Находит неиспользуемые файлы, экспорты, зависимости, типы, интерфейсы.

**Установка:**
```bash
npm install --save-dev knip
```

**Использование:**
```bash
npx knip
```

**Добавить в package.json:**
```json
"scripts": {
  "check:unused": "knip"
}
```

**Польза:** Очистка проекта от мёртвого кода, уменьшение размера bundle, улучшение поддерживаемости.

---

### 2. **tsc --noEmit** - Проверка типов без сборки ⭐⭐⭐⭐⭐
**Зачем:** Быстрая проверка типов TypeScript без генерации файлов.

**Текущий build:** `tsc` уже проверяет типы, но можно добавить отдельный скрипт для быстрой проверки.

**Добавить в package.json:**
```json
"scripts": {
  "typecheck": "tsc --noEmit"
}
```

**Польза:** Быстрая проверка типов во время разработки, можно запускать в CI/CD.

---

### 3. **npm audit** - Проверка уязвимостей ⭐⭐⭐⭐
**Зачем:** Поиск известных уязвимостей в зависимостях.

**Использование:**
```bash
npm audit
npm audit fix  # Автоматическое исправление (осторожно!)
```

**Добавить в package.json:**
```json
"scripts": {
  "security:check": "npm audit",
  "security:fix": "npm audit fix"
}
```

**Польза:** Критично для торгового бота с финансовыми транзакциями.

---

### 4. **depcheck** - Проверка неиспользуемых зависимостей ⭐⭐⭐
**Зачем:** Альтернатива knip, но более простая, фокусируется только на зависимостях.

**Установка:**
```bash
npm install --save-dev depcheck
```

**Использование:**
```bash
npx depcheck
```

**Добавить в package.json:**
```json
"scripts": {
  "check:deps": "depcheck"
}
```

**Примечание:** Если используете knip, depcheck может быть избыточным.

---

## ⚠️ Не рекомендуется (избыточные для этого проекта)

### ❌ eslint-plugin-security
- **Почему:** Большинство правил уже покрыты ESLint, специфичные правила редко срабатывают для Node.js проектов.

### ❌ typescript-eslint/strict
- **Почему:** У вас уже `strict: true` в tsconfig.json, дополнительные правила могут конфликтовать.

### ❌ sonarjs
- **Почему:** Избыточно для MVP, требует сложной настройки, больше для больших команд.

### ❌ @typescript-eslint/ban-ts-comment
- **Почему:** У вас уже есть это правило в `@typescript-eslint/recommended`.

---

## 📋 Рекомендуемый набор скриптов для package.json

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext .ts",
    "lint:fix": "eslint . --ext .ts --fix",
    "format:check": "prettier --check .",
    "format": "prettier --write .",
    "check:unused": "knip",
    "check:deps": "depcheck",
    "security:check": "npm audit",
    "check:all": "npm run typecheck && npm run lint && npm run format:check && npm run check:unused",
    "dev": "tsx watch src/index.ts",
    "start:prod": "node dist/index.js"
  }
}
```

---

## 🚀 Автоматизация в CI/CD (опционально)

Если планируете CI/CD (GitHub Actions, GitLab CI), добавьте:

```yaml
# .github/workflows/checks.yml
- name: Type Check
  run: npm run typecheck

- name: Lint
  run: npm run lint

- name: Security Audit
  run: npm run security:check

- name: Check Unused Code
  run: npm run check:unused
```

---

## 💡 Полезные команды для ежедневной работы

```bash
# Перед коммитом (быстрая проверка)
npm run typecheck && npm run lint

# Полная проверка перед релизом
npm run check:all

# Проверка безопасности
npm run security:check

# Поиск неиспользуемого кода (периодически)
npm run check:unused
```

