/**
 * WhatsApp Baileys Multi-Merchant Bridge
 * =====================================
 * - Supports MULTIPLE merchants simultaneously (Multi-Tenant)
 * - Each merchant has an isolated session in ./sessions/merchant_<id>
 * - Multi-tenant WhatsApp AI Assistant Bridge
 * - Connects strictly to CodFlow OMS PHP backend (https://codflow.lk)
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    delay,
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fetch from 'node-fetch';
import qrcode from 'qrcode';
import { Boom } from '@hapi/boom';
import { mkdir, readdir, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import 'dotenv/config';

// ============================================
// CONFIG
// ============================================
// Connects strictly to https://codflow.lk PHP backend
const PHP_BACKEND_URL = (process.env.PHP_BACKEND_URL || 'https://codflow.lk').replace(/\/$/, '');
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET   || 'smartzone_baileys_secret_2026';
const PORT            = process.env.PORT            || 3000;
const SESSIONS_BASE   = process.env.SESSION_DIR     || './sessions';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CodFlowBaileysBridge/2.0',
    'Accept': 'application/json, text/plain, */*'
};

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
function formatJID(jidOrPhone) {
    if (typeof jidOrPhone !== 'string') return '';
    if (jidOrPhone.includes('@')) {
        return jidOrPhone.replace('@c.us', '@s.whatsapp.net');
    }
    const clean = jidOrPhone.replace(/[^0-9]/g, '');
    if (clean.length > 12) {
        return clean + '@lid';
    }
    if (clean.startsWith('0') && clean.length === 10) {
        return '94' + clean.substring(1) + '@s.whatsapp.net';
    }
    return clean + '@s.whatsapp.net';
}

async function resolveSenderInfo(sock, msg) {
    const remoteJid = msg.key?.remoteJid || '';
    let realPhone = null;
    const pushName = msg.pushName || '';

    if (remoteJid.endsWith('@s.whatsapp.net')) {
        realPhone = remoteJid.replace(/@.*/, '');
    } else if (remoteJid.endsWith('@lid')) {
        // 1. Check alternate properties in Baileys message key
        const altJid = msg.key?.remoteJidAlt || msg.key?.participantAlt || msg.key?.participant || msg.participant;
        if (altJid && typeof altJid === 'string' && altJid.endsWith('@s.whatsapp.net')) {
            realPhone = altJid.replace(/@.*/, '');
        }

        // 2. Query Baileys signalRepository LID to Phone (PN) mapping cache
        if (!realPhone) {
            try {
                if (sock?.signalRepository?.lidMapping?.getPNForLID) {
                    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
                    if (pnJid && typeof pnJid === 'string' && pnJid.endsWith('@s.whatsapp.net')) {
                        realPhone = pnJid.replace(/@.*/, '');
                    }
                }
            } catch (e) {
                // not yet in LID cache
            }
        }
    }

    const senderPhone = realPhone || remoteJid.replace(/@.*/, '');
    const senderName = pushName || (realPhone ? ('+' + realPhone) : 'WhatsApp User');

    return {
        senderPhone,
        realPhone,
        senderName,
        senderJID: remoteJid
    };
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
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                merchant_id: String(merchantId),
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

async function forwardMessageToPHP(merchantId, phone, name, messageText, messageId, sock, remoteJid) {
    try {
        const response = await fetch(`${PHP_BACKEND_URL}/api/bridge_receive.php`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                merchant_id: String(merchantId),
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
            const targetJid = remoteJid || formatJID(phone);

            // Natural typing delay
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
                await delay(600 + Math.random() * 800);
                await sock.sendPresenceUpdate('paused', targetJid);
            } catch (e) {
                // ignore presence error
            }

            try {
                await sock.sendMessage(targetJid, { text: result.reply });
                console.log(`[Merchant ${merchantId}] 📤 Sent reply to ${targetJid}: ${result.reply.substring(0, 40)}...`);
            } catch (sendErr) {
                console.warn(`[Merchant ${merchantId}] Failed to send to ${targetJid}, trying fallback:`, sendErr.message);
                if (targetJid && targetJid.includes('@lid')) {
                    const fallbackJid = formatJID(phone);
                    await sock.sendMessage(fallbackJid, { text: result.reply });
                    console.log(`[Merchant ${merchantId}] 📤 Fallback sent to ${fallbackJid}`);
                }
            }
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
        lastQrTime: null,
        lastConnectAttempt: null,
        connectionState: 'disconnected', // disconnected | connecting | connected
        phone: null,
        reconnectTimer: null,
    };

    sessions.set(id, sessionData);
    return sessionData;
}

// ============================================
// CLOUD PERSISTENCE HELPERS (MySQL Sync via PHP)
// ============================================
const syncDebounceTimers = new Map();

function scheduleCloudSync(merchantId) {
    const id = String(merchantId);
    if (syncDebounceTimers.has(id)) {
        clearTimeout(syncDebounceTimers.get(id));
    }
    const timer = setTimeout(async () => {
        syncDebounceTimers.delete(id);
        await syncSessionToCloud(id);
    }, 3500); // Debounce 3.5 seconds
    syncDebounceTimers.set(id, timer);
}

async function syncSessionToCloud(merchantId) {
    const id = String(merchantId);
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);
    if (!existsSync(sessionDir)) return;

    try {
        const fileNames = await readdir(sessionDir);
        const filesObj = {};
        for (const f of fileNames) {
            const filePath = path.join(sessionDir, f);
            const content = await readFile(filePath);
            filesObj[f] = content.toString('base64');
        }

        if (Object.keys(filesObj).length === 0 || !filesObj['creds.json']) return;

        console.log(`[Merchant ${id}] 📤 Syncing ${Object.keys(filesObj).length} session files to cloud backup (${PHP_BACKEND_URL})...`);
        const res = await fetch(`${PHP_BACKEND_URL}/api/bridge_session_sync.php`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                action: 'save',
                merchant_id: String(id),
                files: filesObj,
            }),
            signal: AbortSignal.timeout(15000),
        });
        const result = await res.json();
        if (result && result.success) {
            console.log(`[Merchant ${id}] ☁️ Cloud backup synced successfully!`);
        }
    } catch (e) {
        console.warn(`[Merchant ${id}] Cloud sync error:`, e.message);
    }
}

async function restoreSessionFromCloud(merchantId) {
    const id = String(merchantId);
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);

    try {
        console.log(`[Merchant ${id}] 📥 Checking cloud backup for saved credentials on ${PHP_BACKEND_URL}...`);
        const res = await fetch(`${PHP_BACKEND_URL}/api/bridge_session_sync.php?action=load&merchant_id=${id}`, {
            headers: {
                ...COMMON_HEADERS,
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data && data.success && data.files && data.files['creds.json']) {
            if (!existsSync(sessionDir)) {
                await mkdir(sessionDir, { recursive: true });
            }
            for (const [fileName, base64Content] of Object.entries(data.files)) {
                const filePath = path.join(sessionDir, fileName);
                const buf = Buffer.from(base64Content, 'base64');
                await writeFile(filePath, buf);
            }
            console.log(`[Merchant ${id}] ✅ Restored ${Object.keys(data.files).length} session files from ${PHP_BACKEND_URL}!`);
            return true;
        }
    } catch (e) {
        console.warn(`[Merchant ${id}] Cloud restore probe failed on ${PHP_BACKEND_URL}:`, e.message);
    }
    return false;
}

async function deleteSessionFromCloud(merchantId) {
    const id = String(merchantId);
    try {
        await fetch(`${PHP_BACKEND_URL}/api/bridge_session_sync.php`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                action: 'delete',
                merchant_id: String(id),
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {}
}

// ============================================
// CONNECT SESSION TO WHATSAPP
// ============================================
async function connectSession(merchantId) {
    const session = await getOrCreateSession(merchantId);
    const id = session.merchantId;
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);

    // If already connected with an active socket, return current session
    if (session.connectionState === 'connected' && session.sock) {
        return session;
    }

    // Concurrency guard: If currently connecting and has an active socket within last 45s, do NOT restart socket!
    if (session.connectionState === 'connecting' && session.sock) {
        const attemptAge = Date.now() - (session.lastConnectAttempt || 0);
        if (attemptAge < 45000) {
            console.log(`[Merchant ${id}] ⏳ Connection already in progress (${Math.round(attemptAge / 1000)}s ago). Reusing existing socket.`);
            return session;
        }
    }

    // Safely tear down any previous hanging socket before starting a fresh one
    if (session.sock) {
        try {
            console.log(`[Merchant ${id}] 🧹 Cleaning up previous socket...`);
            session.sock.ev.removeAllListeners();
            session.sock.end(undefined);
        } catch (e) {}
        session.sock = null;
    }

    clearTimeout(session.reconnectTimer);

    if (!existsSync(sessionDir)) {
        await mkdir(sessionDir, { recursive: true });
    }

    // If local creds are missing (e.g. after Render container restart), restore from MySQL cloud backup
    if (!existsSync(path.join(sessionDir, 'creds.json'))) {
        await restoreSessionFromCloud(id);
    }

    console.log(`[Merchant ${id}] 🔄 Connecting session...`);
    session.connectionState = 'connecting';
    session.lastConnectAttempt = Date.now();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        retryRequestDelayMs: 2500,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
    });

    session.sock = sock;

    // ==========================================
    // Event: Connection Update
    // ==========================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[Merchant ${id}] 📱 New QR code generated`);
            session.connectionState = 'connecting';
            session.lastQrTime = Date.now();
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
                console.log(`[Merchant ${id}] 🚪 Logged out event from WhatsApp. Clearing local directory.`);
                session.phone = null;
                await notifyPHPStatus(id, 'disconnected', { reason: 'logged_out' });
                // Clean auth directory for fresh start, but preserve cloud backup so it is only deleted on deliberate user logout
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

            // Ensure credentials are backed up immediately after successful link
            scheduleCloudSync(id);
        }
    });

    // ==========================================
    // Event: Save Credentials (Local + Cloud Backup)
    // ==========================================
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        scheduleCloudSync(id);
    });

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

            const { senderPhone, senderName, senderJID } = await resolveSenderInfo(sock, msg);

            console.log(`[Merchant ${id}] 📩 Incoming from ${senderName} (${senderPhone}): "${messageText}"`);

            await forwardMessageToPHP(id, senderPhone, senderName, messageText, msg.key.id, sock, senderJID);
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
            session.sock.ev.removeAllListeners();
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

    // Explicit user logout: clear cloud backup in MySQL
    await deleteSessionFromCloud(id);
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

    // If QR is initializing and not ready yet, wait up to 3.5 seconds for it to arrive
    if (!session.qrCodeData && session.connectionState === 'connecting') {
        for (let i = 0; i < 18; i++) {
            await delay(200);
            if (session.qrCodeData || session.connectionState === 'connected') break;
        }
    }

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

/**
 * POST /send-message (Unified alias endpoint)
 * Body: { merchant_id: 1, phone: "94786800086", message: "Hello!" }
 */
app.post('/send-message', verifySecret, async (req, res) => {
    const merchantId = req.body.merchant_id || req.body.merchantId;
    const { phone, message } = req.body;

    if (!merchantId || !phone || !message) {
        return res.status(400).json({ error: 'merchant_id, phone and message are required' });
    }

    const session = sessions.get(String(merchantId));
    if (!session || session.connectionState !== 'connected' || !session.sock) {
        return res.status(503).json({ error: `WhatsApp for merchant ${merchantId} is not connected` });
    }

    try {
        const jid = formatJID(phone);
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
    const restoredIds = new Set();
    try {
        // 1. Restore from local disk if folders exist
        if (existsSync(SESSIONS_BASE)) {
            const dirs = await readdir(SESSIONS_BASE, { withFileTypes: true });
            for (const dir of dirs) {
                if (dir.isDirectory() && dir.name.startsWith('merchant_')) {
                    const merchantId = dir.name.replace('merchant_', '');
                    restoredIds.add(String(merchantId));
                    console.log(`[Startup] Restoring local session for merchant ${merchantId}...`);
                    connectSession(merchantId).catch(err => {
                        console.error(`[Startup] Failed to restore merchant ${merchantId}:`, err.message);
                    });
                }
            }
        }

        // 2. Query PHP backend for active merchants with saved backups
        try {
            const activeRes = await fetch(`${PHP_BACKEND_URL}/api/bridge_session_sync.php?action=list_active`, {
                headers: { 'X-Bridge-Secret': BRIDGE_SECRET },
                signal: AbortSignal.timeout(10000),
            });
            if (activeRes.ok) {
                const activeData = await activeRes.json();
                if (activeData && activeData.success && Array.isArray(activeData.merchants)) {
                    for (const mId of activeData.merchants) {
                        const idStr = String(mId);
                        if (!restoredIds.has(idStr)) {
                            console.log(`[Startup] Restoring cloud-backed session for merchant ${idStr}...`);
                            connectSession(idStr).catch(err => {
                                console.error(`[Startup] Failed to restore cloud merchant ${idStr}:`, err.message);
                            });
                        }
                    }
                }
            }
        } catch (cloudErr) {
            console.warn('[Startup] Cloud active sessions check:', cloudErr.message);
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
