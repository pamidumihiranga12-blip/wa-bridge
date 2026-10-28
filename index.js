/**
 * WhatsApp Baileys Multi-Merchant Bridge
 * =====================================
 * - Supports MULTIPLE merchants simultaneously (Multi-Tenant)
 * - Each merchant has an isolated session in ./sessions/merchant_<id>
 * - Unlimited contacts and messages (100% Free)
 * - Connects to PHP backend (https://smartzonelk.com.lk)
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    Browsers,
    delay,
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fetch from 'node-fetch';
import qrcode from 'qrcode';
import { Boom } from '@hapi/boom';
import { mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import 'dotenv/config';

// ============================================
// CONFIG
// ============================================
const PHP_BACKEND_URL = (process.env.PHP_BACKEND_URL || 'https://smartzonelk.com.lk').replace(/\/$/, '');
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET   || 'smartzone_baileys_secret_2026';
const PORT            = process.env.PORT            || 3000;
const SESSIONS_BASE   = process.env.SESSION_DIR     || './sessions';

const logger = pino({ level: 'silent' });

// ============================================
// IN-MEMORY SESSIONS REGISTRY
// Map<merchantId, SessionData>
// ============================================
const sessions = new Map();

// Ensure base sessions directory exists
if (!existsSync(SESSIONS_BASE)) {
    await mkdir(SESSIONS_BASE, { recursive: true });
}

// ============================================
// HELPER: Format Phone to JID
// ============================================
function formatJID(phone) {
    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0') && phone.length === 10) {
        phone = '94' + phone.substring(1);
    }
    return phone + '@s.whatsapp.net';
}

function extractMessageText(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        null
    );
}

// ============================================
// NOTIFY PHP BACKEND
// ============================================
async function notifyPHPStatus(merchantId, event, data) {
    try {
        await fetch(`${PHP_BACKEND_URL}/api/bridge_status.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                merchant_id: parseInt(merchantId, 10),
                event,
                data,
                timestamp: Date.now(),
            }),
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        console.warn(`[Merchant ${merchantId}] Could not notify PHP status (${event}):`, err.message);
    }
}

async function forwardMessageToPHP(merchantId, phone, name, messageText, messageId, sock) {
    try {
        const response = await fetch(`${PHP_BACKEND_URL}/api/bridge_receive.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                merchant_id: parseInt(merchantId, 10),
                phone,
                name,
                message: messageText,
                message_id: messageId,
                timestamp: Date.now(),
            }),
            signal: AbortSignal.timeout(35000),
        });

        if (!response.ok) {
            console.error(`[Merchant ${merchantId}] PHP error: ${response.status}`, await response.text());
            return;
        }

        const result = await response.json();

        // If PHP returns a reply, send it out immediately via WhatsApp
        if (result && result.reply && sock) {
            const jid = formatJID(phone);

            // Natural typing delay
            try {
                await sock.sendPresenceUpdate('composing', jid);
                await delay(800 + Math.random() * 1200);
                await sock.sendPresenceUpdate('paused', jid);
            } catch (e) {
                // ignore presence error
            }

            await sock.sendMessage(jid, { text: result.reply });
            console.log(`[Merchant ${merchantId}] 📤 Sent reply to ${phone}: ${result.reply.substring(0, 40)}...`);
        }

    } catch (err) {
        console.error(`[Merchant ${merchantId}] Error forwarding to PHP:`, err.message);
    }
}

// ============================================
// CORE: GET OR CREATE SESSION
// ============================================
async function getOrCreateSession(merchantId) {
    const id = String(merchantId);
    if (sessions.has(id)) {
        return sessions.get(id);
    }

    const sessionData = {
        merchantId: id,
        sock: null,
        qrCodeData: null,
        connectionState: 'disconnected', // disconnected | connecting | connected
        phone: null,
        store: makeInMemoryStore({ logger }),
        reconnectTimer: null,
    };

    sessions.set(id, sessionData);
    return sessionData;
}

// ============================================
// CONNECT SESSION TO WHATSAPP
// ============================================
async function connectSession(merchantId) {
    const session = await getOrCreateSession(merchantId);

    // If already connected or connecting, return current session
    if (session.connectionState === 'connected' && session.sock) {
        return session;
    }

    const id = session.merchantId;
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);

    if (!existsSync(sessionDir)) {
        await mkdir(sessionDir, { recursive: true });
    }

    console.log(`[Merchant ${id}] 🔄 Connecting session...`);
    session.connectionState = 'connecting';

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: false,
    });

    session.sock = sock;
    session.store.bind(sock.ev);

    // ==========================================
    // Event: Connection Update
    // ==========================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[Merchant ${id}] 📱 New QR code generated`);
            session.connectionState = 'connecting';
            try {
                session.qrCodeData = await qrcode.toDataURL(qr);
                await notifyPHPStatus(id, 'qr_update', { qr_base64: session.qrCodeData });
            } catch (qrErr) {
                console.error(`[Merchant ${id}] QR encode error:`, qrErr);
            }
        }

        if (connection === 'close') {
            session.connectionState = 'disconnected';
            session.qrCodeData = null;

            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`[Merchant ${id}] ❌ Connection closed. Code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[Merchant ${id}] 🚪 Logged out. Session cleared.`);
                session.phone = null;
                await notifyPHPStatus(id, 'disconnected', { reason: 'logged_out' });
                // Clean auth directory for fresh start
                try {
                    await rm(sessionDir, { recursive: true, force: true });
                } catch (e) {}
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log(`[Merchant ${id}] 📱 Connection replaced by another session.`);
                await notifyPHPStatus(id, 'disconnected', { reason: 'replaced' });
            } else {
                // Auto reconnect after 5s
                console.log(`[Merchant ${id}] 🔄 Reconnecting in 5 seconds...`);
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = setTimeout(() => connectSession(id), 5000);
            }

        } else if (connection === 'open') {
            session.connectionState = 'connected';
            session.qrCodeData = null;
            session.phone = sock.user?.id ? sock.user.id.split(':')[0] : null;
            console.log(`[Merchant ${id}] ✅ WhatsApp Connected! Number: +${session.phone}`);

            await notifyPHPStatus(id, 'connected', {
                phone: session.phone,
                name: sock.user?.name || null,
            });
        }
    });

    // ==========================================
    // Event: Save Credentials
    // ==========================================
    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // Event: Incoming Messages
    // ==========================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;

            const messageText = extractMessageText(msg);
            if (!messageText) continue;

            const senderJID   = msg.key.remoteJid;
            const senderPhone = senderJID.replace(/@.*/, '');
            const senderName  = msg.pushName || senderPhone;

            console.log(`[Merchant ${id}] 📩 Incoming from ${senderName} (${senderPhone}): "${messageText}"`);

            await forwardMessageToPHP(id, senderPhone, senderName, messageText, msg.key.id, sock);
        }
    });

    return session;
}

// ============================================
// DISCONNECT / LOGOUT SESSION
// ============================================
async function disconnectSession(merchantId) {
    const id = String(merchantId);
    if (!sessions.has(id)) return true;

    const session = sessions.get(id);
    clearTimeout(session.reconnectTimer);

    try {
        if (session.sock) {
            await session.sock.logout();
        }
    } catch (e) {
        // ignore
    }

    session.connectionState = 'disconnected';
    session.qrCodeData = null;
    session.phone = null;
    session.sock = null;

    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);
    try {
        await rm(sessionDir, { recursive: true, force: true });
    } catch (e) {}

    await notifyPHPStatus(id, 'disconnected', { reason: 'user_logout' });
    sessions.delete(id);
    return true;
}

// ============================================
// EXPRESS API SERVER
// ============================================
const app = express();
app.use(express.json());

// Auth Middleware
const verifySecret = (req, res, next) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== BRIDGE_SECRET) {
        return res.status(403).json({ error: 'Unauthorized: Invalid bridge secret' });
    }
    next();
};

/**
 * Health check & Ping (Used by Render keep-alive)
 */
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp Baileys Multi-Merchant Bridge',
        version: '2.0.0',
        activeSessions: Array.from(sessions.entries()).map(([mId, s]) => ({
            merchant_id: mId,
            status: s.connectionState,
            phone: s.phone,
        })),
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

/**
 * GET /session/:merchantId/status
 * Get connection state and QR code for a specific merchant
 */
app.get('/session/:merchantId/status', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const session = await getOrCreateSession(merchantId);

    res.json({
        merchant_id: merchantId,
        state: session.connectionState,
        phone: session.phone,
        qr: session.connectionState === 'connecting' ? session.qrCodeData : null,
    });
});

/**
 * POST /session/:merchantId/connect
 * Initiate WhatsApp connection / QR generation for a specific merchant
 */
app.post('/session/:merchantId/connect', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const session = await connectSession(merchantId);

    res.json({
        success: true,
        merchant_id: merchantId,
        state: session.connectionState,
        phone: session.phone,
        qr: session.qrCodeData,
    });
});

/**
 * POST /session/:merchantId/disconnect
 * Disconnect or Logout a merchant's WhatsApp
 */
app.post('/session/:merchantId/disconnect', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    await disconnectSession(merchantId);
    res.json({ success: true, merchant_id: merchantId, state: 'disconnected' });
});

/**
 * POST /session/:merchantId/send
 * Send a message via a specific merchant's WhatsApp
 * Body: { phone: "94786800086", message: "Hello!" }
 */
app.post('/session/:merchantId/send', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    const session = sessions.get(String(merchantId));
    if (!session || session.connectionState !== 'connected' || !session.sock) {
        return res.status(503).json({ error: `WhatsApp for merchant ${merchantId} is not connected` });
    }

    try {
        const jid = formatJID(phone);

        // Typing simulation
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            await delay(400 + Math.random() * 600);
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {}

        const sendResult = await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, messageId: sendResult.key?.id, to: jid });
    } catch (err) {
        console.error(`[Merchant ${merchantId}] Send error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// AUTO RESTORE EXISTING SESSIONS ON STARTUP
// ============================================
async function restoreSessions() {
    try {
        if (!existsSync(SESSIONS_BASE)) return;
        const dirs = await readdir(SESSIONS_BASE, { withFileTypes: true });

        for (const dir of dirs) {
            if (dir.isDirectory() && dir.name.startsWith('merchant_')) {
                const merchantId = dir.name.replace('merchant_', '');
                console.log(`[Startup] Restoring session for merchant ${merchantId}...`);
                connectSession(merchantId).catch(err => {
                    console.error(`[Startup] Failed to restore merchant ${merchantId}:`, err.message);
                });
            }
        }
    } catch (err) {
        console.warn('[Startup] Error restoring sessions:', err.message);
    }
}

// Start Server
app.listen(PORT, async () => {
    console.log(`===============================================`);
    console.log(`🚀 Baileys Multi-Merchant Bridge running on :${PORT}`);
    console.log(`📡 Connected PHP Backend: ${PHP_BACKEND_URL}`);
    console.log(`===============================================`);
    await restoreSessions();
});
