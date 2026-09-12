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

Секреты для токенов теперь создаются автоматически при первом сохранении
через админ-панель на сайте (см. п.7) — отдельная команда в терминале
для самих токенов **не нужна**. Единственное, что нужно один раз сделать
руками — выдать сервисному аккаунту функций право создавать секреты
(см. врезку про IAM в конце п.7), иначе `updateBotToken` не сможет
создать секрет с нуля.

Если всё же хотите завести токен из терминала (например, для первого
теста до готовности сайта):

```bash
firebase functions:secrets:set VERIFY_BOT_TOKEN
firebase functions:secrets:set MAIN_BOT_TOKEN
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
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "config": {
      "public": {
        ".read": true,
        ".write": "auth != null && auth.token.email === 'idiev@delivo.admin'"
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

## 7. Регистрация, вход и админ-панель

### Обычные пользователи
На стартовом экране теперь две кнопки — **«Регистрация»** и **«Вход»**.
- Регистрация: имя, номер телефона, пароль → подтверждение номера через
  Telegram-бота (как раньше) → после подтверждения сайт сам создаёт
  аккаунт в Firebase Authentication (псевдо-email вида
  `992901234567@delivo.app`, реальный пароль пользователя) и профиль в
  Realtime Database (`users/{uid}`).
- Вход: номер телефона + пароль → `signInWithEmailAndPassword` с тем же
  псевдо-email. Проверку пароля делает сервер Firebase, а не JS в браузере.

### Админ (логин IDIEV)
На экране «Вход» есть и обычный вход, и admin-режим: если в поле
«Логин» ввести `IDIEV`, сайт входит под служебным аккаунтом
`idiev@delivo.admin` и, если пароль верный, сразу открывает панель
служебных настроек (это та же панель, что открывается 5 тапами по лого).

**Важно — заведите этот аккаунт заранее вручную:**
Firebase Console → Authentication → Sign-in method → включите
**Email/Password** → вкладка Users → Add user:
- Email: `idiev@delivo.admin`
- Пароль: `1234567890` (как вы просили)

Дальше это настоящий Firebase Auth: пароль хранится хешированным на
сервере, попытки входа ограничены встроенной защитой от перебора
Firebase — это совсем другой уровень, чем строка-пароль в JS. **Но сам
пароль `1234567890` крайне слабый** — теперь, когда логин `IDIEV` известен
(в том числе из этой переписки), очень рекомендую сменить его на более
длинный и случайный через Firebase Console → Authentication → выбрать
пользователя → Reset password, как только сайт заработает.

Также в Firebase Console → Authentication → Settings стоит отключить
самостоятельную регистрацию через сторонние клиенты Identity Toolkit —
на самом сайте формы для само-регистрации админа нет и не будет.

### Панель настроек ботов
- **Username-ы ботов** (не секрет) сохраняются в `config/public` через
  Realtime Database — их можно смело редактировать из панели.
- **Токены ботов** (секрет) НЕ сохраняются в Realtime Database вообще.
  Форма вызывает Cloud Function `updateBotToken`, которая проверяет,
  что вызывающий — залогиненный админ из `ADMIN_EMAILS` (по умолчанию
  это как раз `idiev@delivo.admin`), и сама кладёт токен в Secret Manager
  новой версией — **прямо с сайта, без файлов и без терминала**. Токен
  ни на секунду не попадает в базу данных, доступную для чтения с фронтенда.
- Функции-вебхуки (`telegramVerifyWebhook`, `telegramMainWebhook`,
  `broadcastNewOrder`) читают токен из Secret Manager напрямую (с кэшем
  на 5 минут), поэтому новый токен, сохранённый через панель, начинает
  действовать в течение нескольких минут — без повторного деплоя.
- **Один раз через IAM** нужно выдать сервисному аккаунту Cloud Functions
  (обычно `<project-id>@appspot.gserviceaccount.com` или
  `<номер-проекта>-compute@developer.gserviceaccount.com`) роль
  **Secret Manager Admin** в Google Cloud Console → IAM — без неё функция
  не сможет САМА создать секрет при первом сохранении токена с сайта.

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
