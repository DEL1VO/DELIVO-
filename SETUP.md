# DELIVO — подключение Telegram-ботов

## 0. Срочно: отзовите токены, которые были в чате

Токены `8878132450:AAH...` и `8970653874:AAH...` (и любой другой токен,
присланный в переписке) нужно считать скомпрометированными. В @BotFather
для КАЖДОГО из ботов:

```
/mybots → выбрать бота → API Token → Revoke current token
```

Дальше используйте только новые токены, и вводите их исключительно в
терминале в команде из шага 3 — не в чате, не в коде, не в файлах.

## 1. Роли ботов

- **Бот верификации** (ID был 8878132450) — подтверждает номер телефона:
  пользователь вводит номер на сайте → сайт открывает бота → бот показывает
  номер и кнопку «✅ Подтвердить» → после нажатия сайт автоматически
  переходит дальше.
- **Главный бот** (ID был 8970653874) — push-уведомления, заказы, курьеры.
  Сейчас реализовано: регистрация курьеров по `/start` и рассылка новых
  заказов с кнопкой «Принять». Остальные виды push-уведомлений (продавцу,
  покупателю) добавляются в `telegramMainWebhook` / `broadcastNewOrder`
  по той же схеме.

## 2. Установка инструментов

```bash
npm install -g firebase-tools
firebase login
cd delivo
firebase init functions   # выбрать существующий проект delivo-3afab, язык JavaScript
# на вопрос про перезапись папки functions — ответить "нет" и просто
# скопировать сюда functions/index.js и functions/package.json из этого пакета
```

Проект должен быть на плане **Blaze** (pay-as-you-go) — иначе Cloud Functions
не смогут стучаться на api.telegram.org. Включается в консоли Firebase:
Settings → Usage and billing → Modify plan.

## 3. Секреты (токены ботов)

```bash
firebase functions:secrets:set VERIFY_BOT_TOKEN
# вставить НОВЫЙ токен бота-верификатора (после revoke)

firebase functions:secrets:set MAIN_BOT_TOKEN
# вставить НОВЫЙ токен главного бота (после revoke)
```

## 4. Деплой функций

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Firebase выведет URL функций, например:

```
https://us-central1-delivo-3afab.cloudfunctions.net/telegramVerifyWebhook
https://us-central1-delivo-3afab.cloudfunctions.net/telegramMainWebhook
```

## 5. Прописать вебхуки в Telegram

```bash
curl "https://api.telegram.org/bot<НОВЫЙ_VERIFY_TOKEN>/setWebhook?url=https://us-central1-delivo-3afab.cloudfunctions.net/telegramVerifyWebhook"

curl "https://api.telegram.org/bot<НОВЫЙ_MAIN_TOKEN>/setWebhook?url=https://us-central1-delivo-3afab.cloudfunctions.net/telegramMainWebhook"
```

Проверка:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## 6. Правила Realtime Database

Firebase → Realtime Database → Rules:

```json
{
  "rules": {
    "verifications": {
      "$sessionId": {
        ".read": true,
        ".write": "!data.exists()"
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
    },
    "config": {
      "public": {
        ".read": true,
        ".write": "auth != null && auth.token.email === 'admin@example.com'"
      }
    }
  }
}
```

Смысл: сайт (клиент) может только СОЗДАТЬ заявку на верификацию/заказ,
но не может сам выставить `status:"confirmed"` или подставить чужого
курьера — это делают только Cloud Functions через Admin SDK, для которого
правила не действуют. `config/public` теперь тоже защищён — писать туда
может только вошедший через Firebase Auth аккаунт с указанным email
(впишите туда реальный email админа, можно перечислить несколько через `||`).

## 7. Админ-панель на сайте (5 тапов по лого) и токены ботов

Панель открывается 5 тапами по логотипу "D" в шапке приложения.

**Как это устроено и почему именно так:**
- Вход — настоящий **Firebase Authentication** (email + пароль), а не
  строка-пароль в JavaScript. Проверку делает сервер Firebase; открыть
  панель через "Просмотр кода страницы" нельзя, как было бы с паролем,
  зашитым в JS.
- Заведите первого администратора: Firebase Console → Authentication →
  Sign-in method → включите **Email/Password** → вкладка Users → Add user
  → укажите email и пароль. Этот же email впишите в `ADMIN_EMAILS` в
  `functions/index.js` и в правило `config/public` выше.
- В Firebase Console → Authentication → Settings стоит отключить публичную
  регистрацию (или просто не делать в сайте формы `createUser...` — их
  здесь и нет), чтобы никто посторонний не мог сам себе завести аккаунт.
- **Username-ы ботов** (не секрет) сохраняются в `config/public` через
  Realtime Database — их можно смело редактировать из панели.
- **Токены ботов** (секрет) НЕ сохраняются в Realtime Database вообще.
  Форма вызывает Cloud Function `updateBotToken`, которая проверяет,
  что вызывающий — залогиненный админ из `ADMIN_EMAILS`, и сама кладёт
  токен в Secret Manager новой версией. Токен ни на секунду не попадает
  в базу данных, доступную для чтения с фронтенда.
- Функции-вебхуки (`telegramVerifyWebhook`, `telegramMainWebhook`,
  `broadcastNewOrder`) читают токен из Secret Manager напрямую (с кэшем
  на 5 минут), поэтому новый токен, сохранённый через панель, начинает
  действовать в течение нескольких минут — без повторного деплоя.
- Сервисному аккаунту Cloud Functions нужна роль **Secret Manager Secret
  Accessor** и **Secret Manager Secret Version Adder** в IAM (обычно
  выдаётся автоматически при первом `firebase functions:secrets:set`,
  иначе добавьте вручную в Google Cloud Console → IAM).

В `index.html` в `ADMIN_EMAILS` (в `functions/index.js`, не в HTML!)
впишите реальный email администратора — по умолчанию там заглушка
`admin@example.com`.

## 8. Настройка сайта

В `index.html` изначальные значения:

```js
let APP_CONFIG = { verifyBotUsername: 'YourVerifyBot', mainBotUsername: '' };
```

Это только значения по умолчанию до первой загрузки из базы — реальные
username-ы правьте через админ-панель (п.7), они подтянутся из
`config/public` автоматически.

## 9. Как это работает

**Регистрация номера:**
1. Пользователь вводит номер (с префиксом `+992`) и жмёт «Подтвердить через Telegram».
2. Сайт создаёт запись `verifications/{sessionId} = {phone, status:'pending'}`
   и открывает `t.me/<bot>?start=<sessionId>`.
3. Бот получает `/start <sessionId>`, читает номер из базы и присылает
   сообщение с кнопкой «✅ Подтвердить».
4. Пользователь жмёт кнопку → бот ставит `status:'confirmed'`.
5. Сайт слушает эту запись через Realtime Database и, увидев `confirmed`,
   сам переводит пользователя на следующий экран — без ручного ввода кода.

**Заказы:**
При `createOrder()` сайт пишет карточку заказа в `liveOrders/{id}`.
`broadcastNewOrder` рассылает её всем курьерам, которые хоть раз написали
`/start` главному боту. Курьер, первым нажавший «Принять», фиксируется в
`courierChatId`; остальные получают уведомление, что заказ уже разобран.

## 10. Что стоит доделать (не входит в этот пакет)

- Привязка `chatId` из главного бота к конкретному пользователю сайта
  (продавцу/покупателю), чтобы слать им push о статусах заказа — сейчас
  такая привязка реализована только для курьеров.
- Полный цикл через бота: «забрал», «код клиенту», «доставлено».
- TTL/очистка старых записей в `verifications`, чтобы база не росла бесконечно.
- Rate-limiting на `/start`, чтобы не заваливать бота повторными запросами.
- Ограничение по IP/App Check на `updateBotToken`, если админов будет много.
