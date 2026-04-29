const admin = require('firebase-admin');

// 初始化 Firebase Admin (使用環境變數)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // 處理私鑰中的換行符號問題
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // 只允許 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '方法不允許' });
  }

  const { tradeId, idToken } = req.body;

  if (!tradeId || !idToken) {
    return res.status(400).json({ error: '缺少必要的參數 (tradeId 或 idToken)' });
  }

  try {
    // 1. 驗證玩家身分
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid; // 這就是發起交易的人的 UID

    const tradeRef = db.collection('tradeRequests').doc(tradeId);
    const meRef = db.collection('users').doc(uid);

    // 2. 執行資料庫事務 (Transaction)
    await db.runTransaction(async (tx) => {
      const tradeSnap = await tx.get(tradeRef);
      if (!tradeSnap.exists) {
        throw new Error('該交易請求已不存在。');
      }

      const trade = tradeSnap.data();
      if ((trade.status || 'open') !== 'open') {
        throw new Error('這筆交易已經被處理過。');
      }

      const ownerUid = trade.ownerUid || trade.uid || '';
      if (!ownerUid) throw new Error('交易發起者資料異常。');
      if (ownerUid === uid) throw new Error('不能與自己交易。');

      const ownerRef = db.collection('users').doc(ownerUid);

      // 同時取得雙方的資料
      const [meSnap, ownerSnap] = await Promise.all([tx.get(meRef), tx.get(ownerRef)]);

      if (!meSnap.exists) throw new Error('找不到你的玩家資料。');
      if (!ownerSnap.exists) throw new Error('找不到對方的玩家資料。');

      const meCounts = { ...(meSnap.data().ownedCounts || {}) };
      const ownerCounts = { ...(ownerSnap.data().ownedCounts || {}) };

      const giveCardId = String(trade.giveCardId || '').trim();
      const wantCardId = String(trade.wantCardId || '').trim();

      if (!giveCardId || !wantCardId) {
        throw new Error('交易卡片資料不完整。');
      }

      // 檢查雙方是否擁有該卡片
      // 注意：接受者(me)必須擁有對方想要的卡片(wantCardId)
      // 發起者(owner)必須擁有他承諾給出的卡片(giveCardId)
      if ((meCounts[wantCardId] || 0) <= 0) {
        throw new Error(`你擁有的 ${wantCardId} 數量不足。`);
      }
      if ((ownerCounts[giveCardId] || 0) <= 0) {
        throw new Error(`對方已不再擁有 ${giveCardId}。`);
      }

      // 執行交換邏輯
      // 我方：失去想要卡，得到給予卡
      meCounts[wantCardId] = (meCounts[wantCardId] || 0) - 1;
      meCounts[giveCardId] = (meCounts[giveCardId] || 0) + 1;

      // 對方：失去給予卡，得到想要卡
      ownerCounts[giveCardId] = (ownerCounts[giveCardId] || 0) - 1;
      ownerCounts[wantCardId] = (ownerCounts[wantCardId] || 0) + 1;

      // 更新到資料庫
      tx.update(meRef, { ownedCounts: meCounts, updatedAt: Date.now() });
      tx.update(ownerRef, { ownedCounts: ownerCounts, updatedAt: Date.now() });
      
      // 刪除該交易請求
      tx.delete(tradeRef);
    });

    // 傳回成功回應
    return res.status(200).json({ message: '交易成功' });

  } catch (error) {
    console.error('交易錯誤:', error);
    return res.status(400).json({ error: error.message });
  }
}