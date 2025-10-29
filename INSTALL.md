# Инструкции по установке зависимостей

## Стандартная установка

```bash
npm install
```

## Установка tulind (опционально)

Библиотека `tulind` требует предустановленную C-библиотеку `ta-lib`. По умолчанию `tulind` не включен в зависимости проекта, но может быть добавлен после установки `ta-lib`.

### macOS (через Homebrew)

1. Установите ta-lib:
```bash
brew install ta-lib
```

2. Примите лицензию Xcode (если требуется):
```bash
sudo xcodebuild -license
```

3. Установите tulind:
```bash
npm install tulind
```

### Linux (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install ta-lib-dev
npm install tulind
```

### Windows

Скачайте pre-built бинарные файлы ta-lib и укажите пути при установке tulind.

## Примечание

Проект может работать с использованием только `technicalindicators` (без `tulind`). Библиотека `tulind` является опциональной для дополнительной производительности в техническом анализе.

