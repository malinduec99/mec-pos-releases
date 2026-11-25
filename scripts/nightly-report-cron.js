import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, doc, getDoc, addDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyCFGweYcgmcfP5zS6M1ytOfKYKUbHfsols",
    authDomain: "mec-book-shop.firebaseapp.com",
    projectId: "mec-book-shop",
    storageBucket: "mec-book-shop.firebasestorage.app",
    messagingSenderId: "721921338336",
    appId: "1:721921338336:web:bcd6215a75b163145cd985"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

async function runNightlyReport() {
    console.log("🚀 Starting MEC POS 100% Free Cloud Nightly Financial Cron...");

    // Authenticate with Firebase Master Admin
    try {
        await signInWithEmailAndPassword(auth, "mecbookshop@gmail.com", "mec123");
        console.log("🔐 Authenticated with Firebase Master Admin successfully.");
    } catch (authErr) {
        console.warn("Auth failed, attempting anonymous/direct fallback...", authErr.message);
    }

    // 1. Fetch all stores to support multi-merchant automated dispatch
    console.log("🏢 Fetching active stores for daily closing briefs...");
    let stores = [];
    try {
        const storesSnap = await getDocs(collection(db, "stores"));
        stores = storesSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    } catch(e) {
        console.warn("Could not fetch stores list, defaulting to MEC Book Shop:", e.message);
    }

    // Ensure MEC Book Shop is present
    if (!stores.some(s => (s.slug || '').toLowerCase() === 'mec-book-shop')) {
        stores.unshift({
            name: 'MEC Book Shop',
            slug: 'mec-book-shop',
            phone: '0770658356',
            status: 'Active'
        });
    }

    // 2. Query today's data (SL Time: UTC + 5:30)
    const nowSL = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
    const todayStr = nowSL.toISOString().split('T')[0];
    const timeStr = nowSL.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    console.log(`📅 Target Date for Closing: ${todayStr}`);

    const [ordersSnap, productsSnap, customersSnap] = await Promise.all([
        getDocs(collection(db, "orders")),
        getDocs(collection(db, "products")),
        getDocs(collection(db, "customers"))
    ]);

    const allOrders = ordersSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const allProducts = productsSnap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const allCustomers = customersSnap.docs.map(d => ({ docId: d.id, ...d.data() }));

    // 3. Process each merchant store
    for (const store of stores) {
        const storeId = (store.slug || store.docId || 'mec-book-shop').toLowerCase();
        const storeName = store.name || store.storeName || 'MEC POS Store';
        const isMecMaster = (storeId === 'mec-book-shop' || storeId === 'master' || storeId === '1001');

        if (store.status && store.status.toLowerCase() === 'suspended') {
            console.log(`⏩ Skipping suspended store: ${storeName} (${storeId})`);
            continue;
        }

        // Fetch store copilot & SMS settings
        let isAutoEnabled = true;
        let ceoPhone = store.phone || (isMecMaster ? '0770658356' : '');
        let smsConf = {};

        try {
            // 1. Check merchant isolated config first
            const storeConfigDoc = await getDoc(doc(db, "config", storeId));
            if (storeConfigDoc.exists()) {
                const cData = storeConfigDoc.data();
                if (cData.autoCeoWhatsapp !== undefined) isAutoEnabled = !!cData.autoCeoWhatsapp;
                if (cData.copilot_autoCeoWhatsapp !== undefined) isAutoEnabled = !!cData.copilot_autoCeoWhatsapp;
                if (cData.ceoPhone || cData.copilot_ceoPhone) ceoPhone = cData.ceoPhone || cData.copilot_ceoPhone;
                if (cData.smsConfig && cData.smsConfig.apiKey) smsConf = cData.smsConfig;
            }

            // 2. Check stores collection profile
            if (!smsConf.apiKey) {
                const sDoc = await getDoc(doc(db, "stores", storeId));
                if (sDoc.exists() && sDoc.data().smsConfig && sDoc.data().smsConfig.apiKey) {
                    smsConf = sDoc.data().smsConfig;
                }
            }

            // 3. Check appConfig/copilot
            if (!smsConf.apiKey && isMecMaster) {
                const copilotDoc = await getDoc(doc(db, "appConfig", "copilot"));
                if (copilotDoc.exists()) {
                    const cData = copilotDoc.data();
                    if (cData.smsConfig && cData.smsConfig.apiKey) smsConf = cData.smsConfig;
                    if (cData.ceoPhone) ceoPhone = cData.ceoPhone;
                }
            }
        } catch (e) {
            console.warn(`Could not fetch config for store ${storeId}:`, e.message);
        }

        // 4. Universal High-Availability Fallback for MEC Book Shop
        if (!smsConf.apiKey && isMecMaster) {
            smsConf = {
                apiBase: "https://smslenz.lk/api/send-sms",
                apiKey: "40b621ec-69ba-48c4-869b-cf30f3f58791",
                userId: "981",
                senderId: "MECBookShop"
            };
        }

        if (!isAutoEnabled) {
            console.log(`⏸️ Auto Daily Brief is OFF for ${storeName} (${storeId}). Skipping.`);
            continue;
        }

        if (!ceoPhone || ceoPhone === 'N/A') {
            console.log(`⚠️ No CEO phone registered for ${storeName} (${storeId}). Skipping.`);
            continue;
        }

        // Filter orders for this store
        const storeOrders = allOrders.filter(o => {
            const oStore = (o.storeId || 'mec-book-shop').toLowerCase();
            let orderDate = '';
            if (o.timestamp && o.timestamp.seconds) {
                const d = new Date((o.timestamp.seconds * 1000) + (5.5 * 60 * 60 * 1000));
                orderDate = d.toISOString().split('T')[0];
            } else if (o.date) {
                orderDate = o.date;
            }
            return (oStore === storeId || (isMecMaster && !o.storeId)) && orderDate === todayStr && o.status !== 'Void';
        });

        const storeProducts = allProducts.filter(p => {
            const pStore = (p.storeId || 'mec-book-shop').toLowerCase();
            return pStore === storeId || (isMecMaster && !p.storeId);
        });

        const storeCustomers = allCustomers.filter(c => {
            const cStore = (c.storeId || 'mec-book-shop').toLowerCase();
            return cStore === storeId || (isMecMaster && !c.storeId);
        });

        const todayGrossRevenue = storeOrders.reduce((acc, o) => acc + (parseFloat(o.total) || 0), 0);
        const todayOrderCount = storeOrders.length;

        let todayTotalCost = 0;
        storeOrders.forEach(o => {
            (o.items || []).forEach(item => {
                const qty = parseFloat(item.quantity) || 1;
                let cost = parseFloat(item.costPrice || item.buyingPrice || item.cost || 0);
                if (!cost) {
                    const prod = storeProducts.find(p => p.docId === item.docId || p.sku === item.sku);
                    if (prod) cost = parseFloat(prod.cost || prod.buyingPrice) || 0;
                }
                todayTotalCost += (cost * qty);
            });
        });

        const estimatedNetProfit = Math.max(0, todayGrossRevenue - todayTotalCost);
        const profitMargin = todayGrossRevenue > 0 ? ((estimatedNetProfit / todayGrossRevenue) * 100).toFixed(1) : "0.0";
        const totalCreditDebt = storeCustomers.reduce((acc, c) => acc + (parseFloat(c.creditBalance || c.outstanding || 0)), 0);

        // Format phone
        let cleanPhone = ceoPhone.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) {
            cleanPhone = '94' + cleanPhone.substring(1);
        } else if (!cleanPhone.startsWith('94')) {
            cleanPhone = '94' + cleanPhone;
        }

        if (cleanPhone.length !== 11) {
            console.warn(`⚠️ Invalid phone format (${cleanPhone}) for store ${storeName}. Skipping.`);
            continue;
        }

        // Determine SMS Gateway Credentials strictly from merchant config
        const apiBase = smsConf.apiBase || "https://www.smslenz.lk/api/send-sms";
        const apiKey = smsConf.apiKey || "";
        const userId = smsConf.userId || "";
        const senderId = smsConf.senderId || "MECPOS";

        if (!apiKey || !userId) {
            console.log(`ℹ️ SMS Gateway not configured in Settings for merchant ${storeName} (${storeId}). Skipping SMS dispatch.`);
            continue;
        }

        // Strictly check if an SMS brief was ALREADY dispatched today for this branch/store
        let alreadySentSMSToday = false;
        try {
            const taskDoc = await getDoc(doc(db, 'stores', storeId, 'system_tasks', `nightly_brief_${todayStr}`));
            if (taskDoc.exists() && taskDoc.data().status === 'SENT') {
                alreadySentSMSToday = true;
            }
        } catch (_) {}

        if (!alreadySentSMSToday) {
            try {
                const logsSnap = await getDocs(query(
                    collection(db, "ai_copilot_logs"),
                    where("storeId", "==", storeId),
                    limit(10)
                ));
                alreadySentSMSToday = logsSnap.docs.some(d => {
                    const l = d.data();
                    if (l.type !== 'SMS_CEO_MORNING' && l.type !== 'SMS_CEO_CLOUD') return false;
                    const ts = l.timestamp?.seconds ? new Date(l.timestamp.seconds * 1000 + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0] : '';
                    return ts === todayStr;
                });
            } catch (_) {}
        }

        if (alreadySentSMSToday) {
            console.log(`🛡️ SMS brief was ALREADY dispatched today for ${storeName} (${storeId}). Skipping duplicate to protect merchant balance.`);
            continue;
        }

        const smsBrief = 
`[${storeName.toUpperCase()} DAILY BRIEF - ${todayStr}]
Gross Sales: LKR ${todayGrossRevenue.toLocaleString(undefined, {minimumFractionDigits: 2})}
Est. Gross Profit: LKR ${estimatedNetProfit.toLocaleString(undefined, {minimumFractionDigits: 2})} (${profitMargin}%)
Bills: ${todayOrderCount}
Credit Debt: LKR ${totalCreditDebt.toLocaleString(undefined, {minimumFractionDigits: 2})}
MEC POS Virtual CFO`;

        console.log(`📱 Dispatching Daily Financial Brief for ${storeName} to +${cleanPhone} via ${senderId}...`);
        try {
            const smsUrl = new URL(apiBase);
            smsUrl.searchParams.append("user_id", userId);
            smsUrl.searchParams.append("api_key", apiKey);
            smsUrl.searchParams.append("sender_id", senderId);
            smsUrl.searchParams.append("contact", '+' + cleanPhone);
            smsUrl.searchParams.append("message", smsBrief);

            const smsRes = await fetch(smsUrl.toString());
            const smsData = await smsRes.text();
            console.log(`📨 Gateway Response for ${storeName}:`, smsData);

            await setDoc(doc(db, 'stores', storeId, 'system_tasks', `nightly_brief_${todayStr}`), {
                status: 'SENT',
                storeId,
                date: todayStr,
                channel: 'SMS',
                timestamp: serverTimestamp()
            }, { merge: true }).catch(() => {});

            await addDoc(collection(db, "ai_copilot_logs"), {
                type: 'SMS_CEO_CLOUD',
                title: `Nightly Cloud Automated Financial Brief Dispatched`,
                description: `Dispatched daily closing brief to CEO (${ceoPhone}) with LKR ${todayGrossRevenue.toLocaleString()} revenue via SMS Gateway (${senderId}).`,
                storeId: storeId,
                timestamp: serverTimestamp()
            });
        } catch (smsErr) {
            console.error(`⚠️ SMS dispatch error for ${storeName}:`, smsErr.message);
        }
    }

    console.log(`🎉 Cloud Daily Cron execution completed successfully for all stores!`);
    process.exit(0);
}

runNightlyReport().catch(err => {
    console.error("❌ Cron Execution Error:", err);
    process.exit(1);
});
