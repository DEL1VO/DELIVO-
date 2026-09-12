# DELIVO — подключение Telegram-ботов

## 0. Срочно: отзовите старые токены

Токены, которые были отправлены в чат, нужно считать скомпрометированными.
В @BotFather для КАЖДОГО из двух ботов:

```
/mybots → выбрать бота → API Token → Revoke current token
```

Получите новые токены и используйте их ниже. Старые нигде не используйте.

## 1. Роли ботов

- **Бот верификации** — присылает 4-значный код в свой чат по кнопке "Получить код в Telegram" на сайте.
- **Бот заказов/курьеров** — курьер жмёт `/start`, регистрируется; при новом заказе всем курьерам приходит сообщение с кнопкой "Принять заказ".

## 2. Установка инструментов

```bash
npm install -g firebase-tools
firebase login
cd delivo
firebase init functions   # выбрать существующий проект delivo-3afab, язык JavaScript
# когда спросит про папку functions — можно ответить "нет" на перезапись,
# и просто скопировать файлы functions/index.js и functions/package.json из этого архива
```

Проект должен быть на плане **Blaze** (pay-as-you-go) — это нужно, чтобы Cloud Functions
могли делать исходящие запросы к api.telegram.org. Включается в консоли Firebase:
Settings → Usage and billing → Modify plan.

## 3. Секреты (токены ботов)

Токены хранятся не в коде, а в Secret Manager:

```bash
firebase functions:secrets:set VERIFY_BOT_TOKEN
# вставить НОВЫЙ токен бота-верификатора

firebase functions:secrets:set ORDER_BOT_TOKEN
# вставить НОВЫЙ токен бота заказов
```

## 4. Деплой функций

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

После деплоя команда выведет URL двух функций, например:

```
https://us-central1-delivo-3afab.cloudfunctions.net/telegramVerifyWebhook
https://us-central1-delivo-3afab.cloudfunctions.net/telegramOrderWebhook
```

## 5. Прописать вебхуки в Telegram

Для каждого бота (подставьте НОВЫЙ токен и соответствующий URL):

```bash
curl "https://api.telegram.org/bot<VERIFY_BOT_TOKEN>/setWebhook?url=https://us-central1-delivo-3afab.cloudfunctions.net/telegramVerifyWebhook"

curl "https://api.telegram.org/bot<ORDER_BOT_TOKEN>/setWebhook?url=https://us-central1-delivo-3afab.cloudfunctions.net/telegramOrderWebhook"
```

Проверить, что вебхук встал:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## 6. Правила доступа к Realtime Database

Чтобы фронтенд мог читать `/verifications/{sessionId}` и `/liveOrders/{id}`
(и только их), в консоли Firebase → Realtime Database → Rules:

```json
{
  "rules": {
    "verifications": {
      "$sessionId": {
        ".read": true,
        ".write": false
      }
    },
    "liveOrders": {
      "$orderId": {
        ".read": true,
        ".write": "!data.exists() || !data.child('courierChatId').exists()"
      }
    },
    "couriers": {
      ".read": false,
      ".write": false
    }
  }
}
```

Запись в `verifications` и `couriers` делают только Cloud Functions (Admin SDK),
им правила `.read`/`.write` не мешают — они всегда проходят с полным доступом.

## 7. Настройка сайта

В `index.html` замените:

```js
const VERIFY_BOT_USERNAME = 'YourVerifyBot';
```

на реальный username бота-верификатора (без `@`), например `DelivoVerifyBot`.
Это публичное имя, в отличие от токена его можно спокойно хранить в клиентском коде.

## 8. Как это работает дальше

- **Верификация**: сайт создаёт случайный `sessionId`, открывает
  `t.me/<bot>?start=<sessionId>`, бот пишет код в
  `/verifications/{sessionId}` и присылает его пользователю в Telegram.
  Сайт слушает эту запись через Realtime Database и просит ввести код —
  так подтверждается, что человек имеет доступ именно к этому Telegram-аккаунту.
- **Заказы**: при создании заказа (`createOrder()`) сайт пишет краткую
  карточку заказа в `/liveOrders/{id}`. Функция `broadcastNewOrder`
  рассылает её всем курьерам, которые хоть раз написали боту `/start`.
  Первый нажавший "Принять" — фиксируется в `courierChatId`, остальные
  получают уведомление, что заказ уже разобран.

## 9. Что стоит доделать (не входит в этот пакет)

- Полный цикл через бота: "я забрал", "код клиенту", "доставлено" —
  сейчас реализовано только уведомление + первичное принятие заказа.
- Проверка, что аккаунт Telegram, привязанный к коду верификации,
  соответствует реальному пользователю сайта (например, привязка по
  вашей системе аутентификации, а не просто по факту ввода кода).
- Rate-limiting на `/start` в боте верификации, чтобы не заваливать
  Realtime Database повторными кодами при спаме кнопки.
