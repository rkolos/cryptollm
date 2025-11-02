# Инструкция по развертыванию и обновлению MLforex на сервере

## Информация о развертывании

- **Сервер**: 161.35.236.30 (Ubuntu 25.04)
- **Подключение**: `ssh root@161.35.236.30`
- **Директория проекта**: `/home/cryptollm`
- **Процесс-менеджер**: PM2 (приложение `cryptollm-dev`)
- **Режим**: Development (dev)
- **База данных**: PostgreSQL в Docker контейнере `cryptollm-postgres`

## Обновление проекта

### Быстрое обновление (без изменений зависимостей и миграций)

```bash
ssh root@161.35.236.30
cd /home/cryptollm
git pull
pm2 restart cryptollm-dev
```

### Полное обновление (с обновлением зависимостей)

```bash
ssh root@161.35.236.30
cd /home/cryptollm
git pull
npm install
pm2 restart cryptollm-dev
```

### Обновление с миграциями базы данных

```bash
ssh root@161.35.236.30
cd /home/cryptollm
git pull
npm install
npm run migrate:up
pm2 restart cryptollm-dev
```

## Управление через PM2

### Просмотр статуса

```bash
pm2 status
```

### Просмотр логов

```bash
# Все логи
pm2 logs cryptollm-dev

# Только последние 50 строк
pm2 logs cryptollm-dev --lines 50

# Логи в реальном времени
pm2 logs cryptollm-dev --follow

# Только ошибки
pm2 logs cryptollm-dev --err
```

### Управление процессом

```bash
# Перезапуск
pm2 restart cryptollm-dev

# Остановка
pm2 stop cryptollm-dev

# Запуск
pm2 start cryptollm-dev

# Удаление из PM2
pm2 delete cryptollm-dev
```

### Сохранение конфигурации

```bash
# Сохранить текущий список процессов
pm2 save
```

## Управление базой данных

### Запуск PostgreSQL

```bash
cd /home/cryptollm
docker compose up -d postgres
```

### Остановка PostgreSQL

```bash
cd /home/cryptollm
docker compose down
```

### Статус контейнера

```bash
docker ps | grep cryptollm-postgres
docker logs cryptollm-postgres
```

### Выполнение миграций

```bash
cd /home/cryptollm
npm run migrate:up    # Применить миграции
npm run migrate:down   # Откатить последнюю миграцию
```

## Структура файлов

```
/home/cryptollm/
├── .env                    # Переменные окружения (права 600)
├── ecosystem.config.cjs    # Конфигурация PM2
├── docker-compose.yml      # Конфигурация PostgreSQL
├── logs/                   # Логи приложения
│   ├── pm2-out.log        # Стандартный вывод PM2
│   └── pm2-error.log      # Ошибки PM2
└── ...
```

## Проверка работоспособности

### Проверка PM2

```bash
pm2 status cryptollm-dev
```

Статус должен быть `online`. Если статус `errored`, проверьте логи.

### Проверка базы данных

```bash
docker exec cryptollm-postgres pg_isready -U cryptollm
```

### Проверка логов приложения

```bash
pm2 logs cryptollm-dev --lines 20
```

## Решение проблем

### Приложение не запускается

1. Проверьте логи: `pm2 logs cryptollm-dev --err`
2. Проверьте переменные окружения: `cat /home/cryptollm/.env`
3. Проверьте подключение к БД: `docker exec cryptollm-postgres pg_isready -U cryptollm`

### Ошибки подключения к базе данных

1. Убедитесь, что контейнер PostgreSQL запущен: `docker ps | grep cryptollm-postgres`
2. Проверьте переменные DB_HOST, DB_PORT, DB_USER, DB_PASSWORD в `.env`
3. Перезапустите контейнер: `docker compose restart postgres`

### PM2 не сохраняет процессы после перезагрузки

```bash
pm2 startup systemd -u root --hp /root
pm2 save
```

### Обновление зависимостей

```bash
cd /home/cryptollm
rm -rf node_modules package-lock.json
npm install
pm2 restart cryptollm-dev
```

## Важные замечания

- Проект развернут в режиме разработки (dev) с автоперезагрузкой через `tsx watch`
- Файл `.env` имеет права доступа 600 (только root может читать)
- База данных изолирована в отдельной Docker сети `cryptollm-network`
- Логи приложения хранятся в `/home/cryptollm/logs/`

## Контакты и поддержка

При возникновении проблем проверьте:
1. Логи PM2
2. Логи Docker контейнера PostgreSQL
3. Файл `.env` на корректность переменных окружения

