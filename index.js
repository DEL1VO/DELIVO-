/**
 * DELIVO — серверная часть для двух Telegram-ботов.
 *
 * ВАЖНО: токены ботов НИКОГДА не хранятся в этом файле и не попадают
 * в git/клиентский код. Они задаются как Firebase Secrets:
 *
 *   firebase functions:secrets:set VERIFY_BOT_TOKEN
 *   firebase functions:secrets:set ORDER_BOT_TOKEN
 *
 * (см. подробную инструкцию в SETUP.md)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp();

const VERIFY_BOT_TOKEN = defineSecret('VERIFY_BOT_TOKEN');
const ORDER_BOT_TOKEN = defineSecret('ORDER_BOT_TOKEN');

function tgApi(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

function randomCode4() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/* =====================================================================
   1) БОТ ВЕРИФИКАЦИИ
   Пользователь на сайте жмёт "Получить код в Telegram" → открывается
   t.me/<bot>?start=<sessionId>. Бот генерирует 4-значный код, кладёт
   его в /verifications/{sessionId} и присылает пользователю в чат.
   Сайт слушает эту запись в Realtime Database и просит ввести код.
   ===================================================================== */
exports.telegramVerifyWebhook = onRequest(
  { secrets: [VERIFY_BOT_TOKEN] },
  async (req, res) => {
    const update = req.body || {};
    const msg = update.message;

    if (msg && typeof msg.text === 'string' && msg.text.startsWith('/start')) {
      const chatId = msg.chat.id;
      const sessionId = msg.text.split(' ')[1];
      const token = VERIFY_BOT_TOKEN.value();

      if (!sessionId) {
        await tgApi(token, 'sendMessage', {
          chat_id: chatId,
          text: 'Откройте эту ссылку с сайта DELIVO, чтобы получить код подтверждения.',
        });
        return res.sendStatus(200);
      }

      const code = randomCode4();
      await getDatabase().ref(`verifications/${sessionId}`).set({
        code,
        chatId,
        firstName: msg.from?.first_name || '',
        createdAt: Date.now(),
      });

      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `Ваш код подтверждения DELIVO: ${code}\n\nВведите его на сайте. Никому не сообщайте этот код.`,
      });
    }

    res.sendStatus(200);
  }
);

/* =====================================================================
   2) БОТ ЗАКАЗОВ / КУРЬЕРОВ
   - /start от курьера → регистрируем его chatId в /couriers/{chatId}
   - нажатие инлайн-кнопки "Принять заказ" → фиксируем курьера в заказе
   ===================================================================== */
exports.telegramOrderWebhook = onRequest(
  { secrets: [ORDER_BOT_TOKEN] },
  async (req, res) => {
    const update = req.body || {};
    const db = getDatabase();
    const token = ORDER_BOT_TOKEN.value();

    if (update.message && update.message.text === '/start') {
      const chat = update.message.chat;
      const from = update.message.from || {};
      await db.ref(`couriers/${chat.id}`).set({
        chatId: chat.id,
        name: [from.first_name, from.last_name].filter(Boolean).join(' '),
        username: from.username || null,
        registeredAt: Date.now(),
      });
      await tgApi(token, 'sendMessage', {
        chat_id: chat.id,
        text: 'Вы зарегистрированы как курьер DELIVO ✅\nНовые заказы будут приходить сюда с кнопкой «Принять».',
      });
      return res.sendStatus(200);
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || '';

      if (data.startsWith('accept_')) {
        const orderId = data.slice('accept_'.length);
        const orderRef = db.ref(`liveOrders/${orderId}`);
        const snap = await orderRef.get();
        const order = snap.val();

        if (!order || order.courierChatId) {
          await tgApi(token, 'answerCallbackQuery', {
            callback_query_id: cq.id,
            text: 'Этот заказ уже забрал другой курьер.',
            show_alert: true,
          });
          return res.sendStatus(200);
        }

        await orderRef.update({
          courierChatId: cq.from.id,
          courierName: [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' '),
          courierUsername: cq.from.username || null,
          acceptedAt: Date.now(),
        });

        await tgApi(token, 'answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Вы приняли заказ!',
        });
        await tgApi(token, 'editMessageText', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${cq.message.text}\n\n✅ Вы приняли этот заказ.`,
        });

        // сообщаем остальным курьерам, что заказ уже разобран
        const couriersSnap = await db.ref('couriers').get();
        const couriers = couriersSnap.val() || {};
        await Promise.all(
          Object.values(couriers)
            .filter((c) => c.chatId !== cq.from.id)
            .map((c) =>
              tgApi(token, 'sendMessage', {
                chat_id: c.chatId,
                text: `Заказ ${order.publicId || orderId} уже забрал другой курьер.`,
              }).catch(() => {})
            )
        );
      }
    }

    res.sendStatus(200);
  }
);

/* =====================================================================
   3) Рассылка нового заказа всем зарегистрированным курьерам.
   Срабатывает автоматически при создании /liveOrders/{orderId}
   (сайт пишет туда заказ в момент createOrder()).
   ===================================================================== */
exports.broadcastNewOrder = onValueCreated(
  { ref: '/liveOrders/{orderId}', secrets: [ORDER_BOT_TOKEN] },
  async (event) => {
    const order = event.data.val();
    const orderId = event.params.orderId;
    const token = ORDER_BOT_TOKEN.value();
    const db = getDatabase();

    const couriersSnap = await db.ref('couriers').get();
    const couriers = couriersSnap.val() || {};
    if (Object.keys(couriers).length === 0) return;

    const text =
      `🆕 Новый заказ ${order.publicId || ''}\n` +
      `🏪 ${order.shopName || ''}\n` +
      `📦 ${order.itemName || ''}\n` +
      `🏠 ${order.addressLabel || ''}\n` +
      `💵 ${order.total || ''} ₽`;

    await Promise.all(
      Object.values(couriers).map((c) =>
        tgApi(token, 'sendMessage', {
          chat_id: c.chatId,
          text,
          reply_markup: {
            inline_keyboard: [[{ text: 'Принять заказ', callback_data: `accept_${orderId}` }]],
          },
        }).catch(() => {})
      )
    );
  }
);
