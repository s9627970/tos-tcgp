const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

exports.acceptTrade = functions.region('us-central1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入。');
  }

  const uid = context.auth.uid;
  const tradeId = String(data?.tradeId || '').trim();
  if (!tradeId) {
    throw new functions.https.HttpsError('invalid-argument', 'tradeId 不可為空。');
  }

  const tradeRef = db.collection('tradeRequests').doc(tradeId);
  const meRef = db.collection('users').doc(uid);

  await db.runTransaction(async (tx) => {
    const tradeSnap = await tx.get(tradeRef);
    if (!tradeSnap.exists) {
      throw new functions.https.HttpsError('not-found', '交易請求不存在。');
    }

    const trade = tradeSnap.data();
    if ((trade.status || 'open') !== 'open') {
      throw new functions.https.HttpsError('failed-precondition', '這筆交易已被處理。');
    }

    const ownerUid = trade.ownerUid || trade.uid || '';
    if (!ownerUid) {
      throw new functions.https.HttpsError('failed-precondition', '交易資料異常。');
    }
    if (ownerUid === uid) {
      throw new functions.https.HttpsError('failed-precondition', '不能交易自己的請求。');
    }

    const giveCardId = String(trade.giveCardId || '').trim();
    const wantCardId = String(trade.wantCardId || '').trim();
    if (!giveCardId || !wantCardId) {
      throw new functions.https.HttpsError('failed-precondition', '交易卡片資料不完整。');
    }

    const ownerRef = db.collection('users').doc(ownerUid);
    const meSnap = await tx.get(meRef);
    const ownerSnap = await tx.get(ownerRef);

    if (!meSnap.exists) {
      throw new functions.https.HttpsError('not-found', '你的玩家資料不存在。');
    }
    if (!ownerSnap.exists) {
      throw new functions.https.HttpsError('not-found', '對方玩家資料不存在。');
    }

    const meCounts = { ...(meSnap.data().ownedCounts || {}) };
    const ownerCounts = { ...(ownerSnap.data().ownedCounts || {}) };

    if ((meCounts[wantCardId] || 0) <= 0) {
      throw new functions.https.HttpsError('failed-precondition', `你沒有 ${wantCardId}。`);
    }
    if ((ownerCounts[giveCardId] || 0) <= 0) {
      throw new functions.https.HttpsError('failed-precondition', `對方已經沒有 ${giveCardId}。`);
    }

    meCounts[wantCardId] = (meCounts[wantCardId] || 0) - 1;
    meCounts[giveCardId] = (meCounts[giveCardId] || 0) + 1;

    ownerCounts[giveCardId] = (ownerCounts[giveCardId] || 0) - 1;
    ownerCounts[wantCardId] = (ownerCounts[wantCardId] || 0) + 1;

    const now = admin.firestore.FieldValue.serverTimestamp();

    tx.update(meRef, {
      ownedCounts: meCounts,
      updatedAt: now,
      lastTradeAt: now
    });

    tx.update(ownerRef, {
      ownedCounts: ownerCounts,
      updatedAt: now,
      lastTradeAt: now
    });

    tx.delete(tradeRef);
  });

  return { ok: true };
});
