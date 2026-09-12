/**
 * DELIVO — серверная часть для двух Telegram-ботов.
 *
 * ВАЖНО: токены ботов НЕ хранятся в этом файле и НЕ попадают в клиентский
 * код. Они лежат в Google Secret Manager. Обновлять их можно двумя
 * способами:
 *   1) из терминала:  firebase functions:secrets:set VERIFY_BOT_TOKEN
 *   2) из админ-панели на сайте (5 тапов по лого → вход через
 *      Firebase Auth → поле "токен бота") — сайт вызывает функцию
 *      updateBotToken ниже, которая сама кладёт новый токен в Secret
 *      Manager. Токен при этом НИКОГДА не проходит через Realtime
 *      Database и не сохраняется нигде на клиенте.
 *
 * См. подробную инструкцию в SETUP.md.
 */

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

initializeApp();
const smClient = new SecretManagerServiceClient();

/* Список email-ов, которым разрешено менять токены ботов через сайт.
   "idiev@delivo.admin" — это служебный email, под которым в Firebase
   Authentication нужно один раз завести аккаунт с логином IDIEV
   (см. SETUP.md) — на сайте он и выглядит как логин "IDIEV". */
const ADMIN_EMAILS = ['idiev@delivo.admin'];

const SECRET_NAMES = {
  verify: 'VERIFY_BOT_TOKEN',
  main: 'MAIN_BOT_TOKEN',
};

/* Кэш секретов в памяти инстанса функции на 5 минут — чтобы не ходить
   в Secret Manager на каждый апдейт от Telegram, но при этом новый
   токен, сохранённый через админ-панель, подхватывается без деплоя. */
const secretCache = {};
async function getSecretLatest(secretName) {
  const cached = secretCache[secretName];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.value;
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const [version] = await smClient.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  const value = version.payload.data.toString('utf8');
  secretCache[secretName] = { value, ts: Date.now() };
  return value;
}

function tgApi(token, method, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

/* =====================================================================
   0) Обновление токена бота из админ-панели сайта.
   Вызывается через firebase.functions().httpsCallable('updateBotToken').
   Firebase Auth сам проверяет, что запрос подписан валидным ID-токеном
   вошедшего пользователя — подделать это из браузера нельзя.
   Секрет создаётся автоматически при первом сохранении — отдельная
   команда в терминале не нужна, всё делается прямо с сайта.
   ===================================================================== */
async function ensureSecretExists(projectId, secretName) {
  const name = `projects/${projectId}/secrets/${secretName}`;
  try {
    await smClient.getSecret({ name });
  } catch (err) {
    if (err.code === 5 /* NOT_FOUND */) {
      await smClient.createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
    } else {
      throw err;
    }
  }
}

exports.updateBotToken = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Нужно войти в аккаунт администратора.');
  }
  const email = request.auth.token.email;
  if (!email || !ADMIN_EMAILS.includes(email)) {
    throw new HttpsError('permission-denied', 'Этот аккаунт не является администратором.');
  }

  const { botKey, token } = request.data || {};
  const secretName = SECRET_NAMES[botKey];
  if (!secretName) {
    throw new HttpsError('invalid-argument', 'Неизвестный бот.');
  }
  if (!token || typeof token !== 'string' || !/^\d+:[\w-]{30,}$/.test(token.trim())) {
    throw new HttpsError('invalid-argument', 'Похоже, это не похоже на токен Telegram-бота.');
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  await ensureSecretExists(projectId, secretName);
  await smClient.addSecretVersion({
    parent: `projects/${projectId}/secrets/${secretName}`,
    payload: { data: Buffer.from(token.trim(), 'utf8') },
  });
  delete secretCache[secretName]; // чтобы новый токен подхватился сразу

  return { ok: true };
});


/* =====================================================================
   1) БОТ ВЕРИФИКАЦИИ НОМЕРА ТЕЛЕФОНА
   ===================================================================== */
exports.telegramVerifyWebhook = onRequest(async (req, res) => {
  const update = req.body || {};
  const token = await getSecretLatest(SECRET_NAMES.verify);
  const db = getDatabase();

  if (update.message && typeof update.message.text === 'string' && update.message.text.startsWith('/start')) {
    const chatId = update.message.chat.id;
    const sessionId = update.message.text.split(' ')[1];

    if (!sessionId) {
      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Откройте эту ссылку с сайта DELIVO, чтобы подтвердить номер телефона.',
      });
      return res.sendStatus(200);
    }

    const snap = await db.ref(`verifications/${sessionId}`).get();
    const v = snap.val();
    if (!v) {
      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Ссылка устарела. Запросите подтверждение на сайте ещё раз.',
      });
      return res.sendStatus(200);
    }

    await db.ref(`verifications/${sessionId}`).update({ chatId });
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `Подтвердить регистрацию на DELIVO для номера ${v.phone}?`,
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: `confirm_${sessionId}` }]],
      },
    });
    return res.sendStatus(200);
  }

  if (update.callback_query && (update.callback_query.data || '').startsWith('confirm_')) {
    const cq = update.callback_query;
    const sessionId = cq.data.slice('confirm_'.length);

    await db.ref(`verifications/${sessionId}`).update({
      status: 'confirmed',
      chatId: cq.from.id,
      confirmedAt: Date.now(),
    });

    await tgApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Готово!' });
    await tgApi(token, 'editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${cq.message.text}\n\n✅ Подтверждено.`,
    });
  }

  res.sendStatus(200);
});

/* =====================================================================
   2) ГЛАВНЫЙ БОТ (push-уведомления, заказы, курьеры и т.д.)
   ===================================================================== */
exports.telegramMainWebhook = onRequest(async (req, res) => {
  const update = req.body || {};
  const db = getDatabase();
  const token = await getSecretLatest(SECRET_NAMES.main);

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
});

/* =====================================================================
   3) Рассылка нового заказа всем зарегистрированным курьерам.
   ===================================================================== */
exports.broadcastNewOrder = onValueCreated('/liveOrders/{orderId}', async (event) => {
  const order = event.data.val();
  const orderId = event.params.orderId;
  const token = await getSecretLatest(SECRET_NAMES.main);
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
});
