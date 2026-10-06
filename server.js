// ================================================================
// GOMBE FOOTBALL ECONOMY - PAYSTACK PAYOUT BACKEND
// Node.js + Express + Firebase Admin + Paystack
// Deployed on Render
// ================================================================

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ================================================================
// FIREBASE INIT
// ================================================================
// Service account comes from environment variable (see README)
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (err) {
    console.error('❌ Failed to load Firebase service account:', err.message);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ================================================================
// CONFIG
// ================================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const PAYSTACK_API = 'https://api.paystack.co';

// Safety limits
const MIN_TRANSFER = 100;        // ₦100
const MAX_TRANSFER = 500000;     // ₦500,000
const DAILY_TRANSFER_CAP = 2000000; // ₦2M/day

// Admin API key for protecting endpoints (generate a random string)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!PAYSTACK_SECRET) {
    console.error('❌ PAYSTACK_SECRET is required');
    process.exit(1);
}

if (!ADMIN_API_KEY) {
    console.warn('⚠️  ADMIN_API_KEY not set — admin endpoints are unprotected!');
}

// ================================================================
// APP SETUP
// ================================================================
const app = express();

// ================================================================
// WEBHOOK ROUTE (raw body required for signature verification)
// ================================================================
app.post('/webhook/paystack',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET)
            .update(req.body)
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            console.warn('❌ Invalid webhook signature');
            return res.status(401).send('Invalid signature');
        }

        let event;
        try {
            event = JSON.parse(req.body);
        } catch (e) {
            return res.status(400).send('Invalid JSON');
        }

        console.log('📩 Paystack webhook:', event.event, event.data?.reference);

        try {
            if (event.event === 'transfer.success') {
                await handleTransferSuccess(event.data);
            } else if (event.event === 'transfer.failed') {
                await handleTransferFailed(event.data);
            } else if (event.event === 'transfer.reversed') {
                await handleTransferFailed(event.data);
            }
            res.status(200).send('OK');
        } catch (err) {
            console.error('Webhook handler error:', err);
            res.status(500).send('Error');
        }
    }
);

// ================================================================
// JSON BODY PARSER (for all other routes)
// ================================================================
app.use(express.json());

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
function requireAdmin(req, res, next) {
    const provided = req.headers['x-admin-key'];
    if (!provided || provided !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Gombe Football Payout Backend',
        timestamp: new Date().toISOString()
    });
});

// ================================================================
// BALANCE CHECK
// ================================================================
app.get('/api/balance', requireAdmin, async (req, res) => {
    try {
        const response = await axios.get(`${PAYSTACK_API}/balance`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
        });
        res.json({
            success: true,
            balance: response.data.data[0].balance / 100,
            currency: response.data.data[0].currency
        });
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        console.error('Balance check error:', msg);
        res.status(500).json({ error: msg });
    }
});

// ================================================================
// MAIN: PAY WITHDRAWAL
// ================================================================
app.post('/api/pay-withdrawal', requireAdmin, async (req, res) => {
    const { requestId } = req.body;

    if (!requestId) {
        return res.status(400).json({ error: 'requestId is required' });
    }

    try {
        // --------------------------------------------------
        // STEP 1: Read withdrawal request
        // --------------------------------------------------
        const reqRef = db.collection('WithdrawalRequests').doc(requestId);
        const reqDoc = await reqRef.get();

        if (!reqDoc.exists) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }

        const request = reqDoc.data();

        // --------------------------------------------------
        // STEP 2: Verify status is "processing"
        // --------------------------------------------------
        if (request.status !== 'processing') {
            return res.status(400).json({
                error: `Cannot pay. Status is "${request.status}". Must be "processing".`
            });
        }

        // --------------------------------------------------
        // STEP 3: Check amount limits
        // --------------------------------------------------
        const amount = request.nairaAmount;

        if (amount < MIN_TRANSFER) {
            return res.status(400).json({ error: `Amount ₦${amount} below minimum ₦${MIN_TRANSFER}` });
        }
        if (amount > MAX_TRANSFER) {
            return res.status(400).json({ error: `Amount ₦${amount} exceeds maximum ₦${MAX_TRANSFER}` });
        }

        // --------------------------------------------------
        // STEP 4: Check daily cap
        // --------------------------------------------------
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todayTransfers = await db.collection('PaystackTransfers')
            .where('paidAt', '>=', admin.firestore.Timestamp.fromDate(todayStart))
            .where('status', '==', 'success')
            .get();

        let todayTotal = 0;
        todayTransfers.forEach(doc => { todayTotal += doc.data().amount || 0; });

        if (todayTotal + amount > DAILY_TRANSFER_CAP) {
            return res.status(400).json({
                error: `Daily cap ₦${DAILY_TRANSFER_CAP} would be exceeded. Today: ₦${todayTotal}`
            });
        }

        // --------------------------------------------------
        // STEP 5: Get or create Paystack recipient
        // --------------------------------------------------
        let recipientCode;
        try {
            recipientCode = await getOrCreateRecipient(request);
        } catch (err) {
            await reqRef.update({
                status: 'failed',
                failReason: `Recipient failed: ${err.message}`,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(500).json({ error: `Recipient creation failed: ${err.message}` });
        }

        // --------------------------------------------------
        // STEP 6: Initiate transfer
        // --------------------------------------------------
        const reference = `GOMBE_${requestId}_${Date.now()}`;

        let transferResponse;
        try {
            transferResponse = await axios.post(
                `${PAYSTACK_API}/transfer`,
                {
                    source: 'balance',
                    amount: Math.round(amount * 100), // kobo
                    recipient: recipientCode,
                    reason: 'Gombe Football Economy withdrawal',
                    reference: reference
                },
                {
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;

            await reqRef.update({
                status: 'failed',
                failReason: `Transfer failed: ${errMsg}`,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('PaystackTransfers').add({
                requestId,
                userId: request.userId,
                amount,
                reference,
                status: 'failed',
                error: errMsg,
                attemptedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(500).json({ error: errMsg });
        }

        if (!transferResponse.data.status) {
            const errMsg = transferResponse.data.message;
            await reqRef.update({
                status: 'failed',
                failReason: errMsg,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(500).json({ error: errMsg });
        }

        const transferData = transferResponse.data.data;

        // --------------------------------------------------
        // STEP 7: Log transfer
        // --------------------------------------------------
        await db.collection('PaystackTransfers').add({
            requestId,
            userId: request.userId,
            userName: request.userName,
            amount,
            bank: request.bank,
            account: request.account,
            accountName: request.accountName,
            reference,
            paystackTransferCode: transferData.transfer_code,
            paystackStatus: transferData.status,
            recipientCode,
            status: 'pending',
            attemptedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await reqRef.update({
            paystackReference: reference,
            paystackTransferCode: transferData.transfer_code,
            transferInitiatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('✅ Transfer initiated:', reference);

        res.json({
            success: true,
            reference,
            transferCode: transferData.transfer_code,
            message: 'Transfer initiated. Awaiting webhook.'
        });

    } catch (err) {
        console.error('❌ pay-withdrawal error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// HELPER: Get or create Paystack recipient
// ================================================================
async function getOrCreateRecipient(request) {
    const recipientKey = `${request.bank}_${request.account}`;
    const cacheRef = db.collection('PaystackRecipients').doc(recipientKey);
    const cached = await cacheRef.get();

    if (cached.exists && cached.data().recipientCode) {
        return cached.data().recipientCode;
    }

    // Fetch banks
    const bankRes = await axios.get(`${PAYSTACK_API}/bank`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });

    const slugMap = {
        opay: 'OPay Digital Services',
        palmpay: 'PalmPay',
        moniepoint: 'Moniepoint MFB',
        gtbank: 'Guaranty Trust Bank',
        zenith: 'Zenith Bank',
        firstbank: 'First Bank of Nigeria',
        uba: 'United Bank for Africa',
        access: 'Access Bank'
    };

    const target = slugMap[request.bank] || request.bank;
    const bank = bankRes.data.data.find(b =>
        b.name.toLowerCase().includes(target.toLowerCase()) ||
        target.toLowerCase().includes(b.name.toLowerCase())
    );

    if (!bank) {
        throw new Error(`Bank not found: ${request.bank}`);
    }

    // Create recipient
    const recipientRes = await axios.post(
        `${PAYSTACK_API}/transferrecipient`,
        {
            type: 'nuban',
            name: request.accountName || request.userName,
            account_number: request.account,
            bank_code: bank.code,
            currency: 'NGN'
        },
        {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET}`,
                'Content-Type': 'application/json'
            }
        }
    );

    if (!recipientRes.data.status) {
        throw new Error(recipientRes.data.message || 'Recipient creation failed');
    }

    const recipientCode = recipientRes.data.data.recipient_code;

    await cacheRef.set({
        recipientCode,
        bank: request.bank,
        accountNumber: request.account,
        accountName: request.accountName,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return recipientCode;
}

// ================================================================
// WEBHOOK HANDLERS
// ================================================================
async function handleTransferSuccess(data) {
    const reference = data.reference;

    const transfers = await db.collection('PaystackTransfers')
        .where('reference', '==', reference).limit(1).get();

    if (transfers.empty) {
        console.warn('No matching transfer:', reference);
        return;
    }

    const transferDoc = transfers.docs[0];
    const transferData = transferDoc.data();

    await transferDoc.ref.update({
        status: 'success',
        paystackStatus: 'success',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        webhookData: {
            amount: data.amount / 100,
            currency: data.currency,
            status: data.status
        }
    });

    await db.collection('WithdrawalRequests').doc(transferData.requestId).update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paystackReference: reference
    });

    console.log('✅ Transfer success:', reference);
}

async function handleTransferFailed(data) {
    const reference = data.reference;

    const transfers = await db.collection('PaystackTransfers')
        .where('reference', '==', reference).limit(1).get();

    if (transfers.empty) return;

    const transferDoc = transfers.docs[0];
    const transferData = transferDoc.data();

    await transferDoc.ref.update({
        status: 'failed',
        paystackStatus: 'failed',
        failReason: data.reason || data.message || 'Transfer failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const requestDoc = await db.collection('WithdrawalRequests')
        .doc(transferData.requestId).get();

    if (requestDoc.exists) {
        const request = requestDoc.data();

        // Refund tokens
        await db.collection('TapGamersList').doc(request.userId).update({
            tokens: admin.firestore.FieldValue.increment(request.tokens || 0)
        });

        await requestDoc.ref.update({
            status: 'failed',
            failReason: 'Paystack transfer failed',
            refundedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('❌ Transfer failed, tokens refunded:', reference);
    }
}

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💰 Paystack: ${PAYSTACK_SECRET.substring(0, 12)}...`);
});