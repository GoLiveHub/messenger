# Messenger

Веб-мессенджер на React + Express + Socket.io + SQLite. Личные чаты, группы, каналы, секретные чаты с E2E-шифрованием, голосовые сообщения, статусы доставки, реакции, ответы, пересылка, боты, папки и админ-панель.

> **🔴 Живое демо:** https://messenger-production-07ac.up.railway.app/
>
> Стек: **TypeScript · React · Vite · Express · Socket.io · SQLite · Web Push · E2E (ECDH P-256 + AES-GCM) · FTS5**

## Возможности

- Авторизация по номеру телефона (SMS-код) + двухфакторная аутентификация (пароль и TOTP)
- Личные, групповые и канал-чаты с ролями (владелец / админ / участник)
- Секретные чаты — текст E2E-зашифрован (ECDH P-256 + HKDF + AES-GCM)
- Голосовые сообщения (до 5 минут, с визуализацией и перемоткой)
- Файлы, изображения (с миниатюрами), GIF-поиск через Tenor
- Статусы: отправлено / доставлено / прочитано (одна / две галочки)
- Реакции, ответы, цитирование, пересылка
- Блокировка пользователей
- Папки чатов (встроенные + пользовательские)
- Поиск по сообщениям и контактам (FTS5)
- Кастомные стикеры (загрузка + паки)
- Боты: создание, вебхуки, инлайн-режим
- Админ-панель: пользователи, чаты, бэкапы, статистика, логи
- Push-уведомления (Web Push + FCM + APNs)
- Объектное хранилище для медиа (S3-compatible)
- Светлая и тёмная тема, i18n (русский / английский)

## Как запустить

Требуется Node.js 22.13 или новее.

### Windows

```bash
start.bat
```

При первом запуске установятся зависимости, соберутся клиент и сервер, создастся `.env` со случайным ключом. Откройте `http://messenger.local/` или `http://127.0.0.1/`.

### Ручной запуск

```bash
npm install
npm run dev
```

Клиент: `http://127.0.0.1:5173`, сервер: `http://127.0.0.1:3001`.

### Production

```bash
npm run build
node --env-file=.env dist-server/index.js
```

Для интернет-размещения нужен HTTPS (reverse proxy), `NODE_ENV=production`, уникальный `SERVER_SECRET` и настроенный SMS-провайдер.

## Проверки

```bash
npm run typecheck   # TypeScript
npm run build       # Сборка клиента и сервера
npm test            # Интеграционные тесты
```

## Конфигурация

Скопируйте `.env.example` в `.env` и заполните. Ключевые переменные:

| Переменная | Описание |
|---|---|
| `PORT` | Порт Express (по умолчанию 3001) |
| `DB_PATH` | Путь к файлу SQLite |
| `SERVER_SECRET` | Секрет для шифрования сессий (обязателен в production) |
| `SMS_PROVIDER` | `console` / `twilio` / `smsru` / `none` |
| `EXPOSE_DEV_CODE` | Показывать код входа в UI (только для разработки) |
| `ALLOWED_ORIGins` | Разрешённые origin через запятую |

Полный список — в `.env.example`.

## Стек

- **Клиент:** React 19, TypeScript, Vite, Socket.io-client
- **Сервер:** Express, Socket.io, node:sqlite (SQLite WAL), Multer, Sharp
- **Шифрование:** Web Crypto API (ECDH P-256, HKDF, AES-GCM), scrypt для паролей
- **Тесты:** Node.js test runner, Playwright (Chromium + Firefox + WebKit)

## Структура проекта

```
src/
  index.ts          Express-сервер, REST API, роутинг
  auth.ts           Авторизация: SMS-коды, 2FA, TOTP, капча
  sockets.ts        WebSocket: сообщения, typing, звонки, presence
  db.ts             SQLite-схема и миграции
  helpers.ts        Утилиты для БД, publicUser, роли
  config.ts         Конфигурация из переменных окружения
  push.ts           Web Push, FCM, APNs
  crypto/
    e2e.ts          E2E-шифрование секретных чатов
    cryptoWorkerClient.ts   Web Worker для криптографии
  components/       React-компоненты UI
  api.ts            Клиентский API-клиент
  store.ts          Zustand-стор
  i18n.ts           Интернационализация
tests/              Интеграционные тесты
```

## Что нужно для продакшена

- HTTPS через reverse proxy
- Реальный SMS-провайдер (Twilio / SMS.ru)
- Регулярные проверяемые бэкапы базы
- Ротация ключей и forward secrecy для E2E
- Независимый криптографический аудит

Учебный проект, лицензии нет.
