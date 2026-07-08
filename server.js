const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const qrcode = require('qrcode');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const PIX_KEY = '40b028d0-7ae8-4622-9f84-11cc4b2172e7';
const STORE_DB_PATH = path.join(__dirname, 'store.db');
const SERVER_IP = 'play.minepex.com';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://site-minepex.vercel.app';

// ─── Security ───────────────────────────────────────────────────────────────
function sanitize(str) {
    return String(str).replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16);
}

const purchaseLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Muitas tentativas. Tente novamente mais tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─── Database ───────────────────────────────────────────────────────────────
let storeDb = null;

async function initDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(STORE_DB_PATH)) {
        const buf = fs.readFileSync(STORE_DB_PATH);
        storeDb = new SQL.Database(buf);
    } else {
        storeDb = new SQL.Database();
    }

    storeDb.run(`
        CREATE TABLE IF NOT EXISTS purchases (
            id TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            player_uuid TEXT,
            item_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            price REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'BRL',
            payment_type TEXT NOT NULL DEFAULT 'pix',
            pix_txid TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
            paid_at INTEGER,
            delivered_at INTEGER
        )
    `);
    storeDb.run(`
        CREATE TABLE IF NOT EXISTS mobcoins_purchases (
            id TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            player_uuid TEXT,
            item_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            cost INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
            delivered_at INTEGER
        )
    `);
    saveDb();
    console.log('[DB] Database initialized.');
}

function saveDb() {
    if (storeDb) {
        const data = storeDb.export();
        fs.writeFileSync(STORE_DB_PATH, Buffer.from(data));
    }
}

function queryAll(db, sql, params = []) {
    if (!db) return [];
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    } catch (e) {
        console.error('[DB] Query error:', e.message);
        return [];
    }
}

function queryOne(db, sql, params = []) {
    const rows = queryAll(db, sql, params);
    return rows.length > 0 ? rows[0] : null;
}

// ─── Store Items ────────────────────────────────────────────────────────────
const STORE_ITEMS = {
    pix: {
        'vip':    { name: 'Rank VIP',    price: 15.00,  command: 'lp user %player% parent addtemp vip 30d' },
        'elite':  { name: 'Rank ELITE',  price: 35.00,  command: 'lp user %player% parent addtemp elite 30d' },
        'ultra':  { name: 'Rank ULTRA',  price: 60.00,  command: 'lp user %player% parent addtemp ultra 30d' },
        'media':  { name: 'Rank MÍDIA',  price: 100.00, command: 'lp user %player% parent addtemp media 30d' },
        'famous': { name: 'Rank FAMOSO', price: 150.00, command: 'lp user %player% parent addtemp famous 30d' },
    },
    mobcoins: {
        'nether_star':     { name: 'Estrela do Nether',            cost: 50000,  command: 'give %player% nether_star 1' },
        'heavy_core':      { name: 'Núcleo Pesado',                cost: 100000, command: 'give %player% heavy_core 1' },
        'totem':           { name: 'Totem da Imortalidade',        cost: 50000,  command: 'give %player% totem_of_undying 1' },
        'elytra':          { name: 'Elytra',                       cost: 5000,   command: 'give %player% elytra 1' },
        'trident':         { name: 'Tridente',                     cost: 10000,  command: 'give %player% trident 1' },
        'enchanted_apple': { name: 'Maçã Dourada Encantada',       cost: 40000,  command: 'give %player% enchanted_golden_apple 1' },
        'lucky_card':      { name: 'Carta da Sorte',               cost: 600,    command: 'givetokens %player% 1 lucky' },
        'super_stick':     { name: 'Bastão Super (64)',             cost: 12000,  command: 'mm i give %player% super_stick 64' },
        'flare':           { name: 'Sinalizador de Comboio',       cost: 8000,   command: 'envoy flare default %player% 1' },
        'vip_30d':         { name: 'VIP (30 dias)',                cost: 50000,  command: 'lp user %player% parent addtemp vip 30d' },
        'elite_30d':       { name: 'ELITE (30 dias)',              cost: 100000, command: 'lp user %player% parent addtemp elite 30d' },
        'ultra_30d':       { name: 'ULTRA (30 dias)',              cost: 150000, command: 'lp user %player% parent addtemp ultra 30d' },
        'media_30d':       { name: 'MÍDIA (30 dias)',              cost: 200000, command: 'lp user %player% parent addtemp media 30d' },
        'famous_30d':      { name: 'FAMOSO (30 dias)',             cost: 250000, command: 'lp user %player% parent addtemp famous 30d' },
    }
};

// ─── PIX Payload Generator ──────────────────────────────────────────────────
function generatePixPayload(amount, txid, description) {
    const amountStr = amount.toFixed(2);
    const pixKeyClean = PIX_KEY.replace(/-/g, '');

    const payload = [
        '000201',
        '26' + buildTLV('00', 'br.gov.bcb.pix') + buildTLV('01', pixKeyClean) + (description ? buildTLV('02', description.substring(0, 72)) : ''),
        '52040000',
        '5303986',
        '54' + padTLV(amountStr.length) + amountStr,
        '5802BR',
        '59' + padTLV('Minepex Legends'.length) + 'Minepex Legends',
        '60' + padTLV('SAO PAULO'.length) + 'SAO PAULO',
        '62' + buildTLV('05', txid.substring(0, 25)),
        '6304',
    ].join('');

    return payload + crc16CCITT(payload);
}

function buildTLV(id, value) { return id + padTLV(value.length) + value; }
function padTLV(len) { return len.toString().padStart(2, '0'); }

function crc16CCITT(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: [ALLOWED_ORIGIN], methods: ['GET', 'POST'], credentials: false }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// ─── API: Store Items ───────────────────────────────────────────────────────
app.get('/api/store/items', (req, res) => res.json(STORE_ITEMS));

// ─── API: Server Status ─────────────────────────────────────────────────────
app.get('/api/haiz/status', async (req, res) => {
    try {
        const r = await fetch(`https://api.mcsrvstat.us/2/${SERVER_IP}`);
        const mc = await r.json();
        res.json({
            online: mc.online || false,
            playerCount: mc.players?.online || 0,
            maxPlayers: mc.players?.max || 0,
            version: mc.version || 'Unknown'
        });
    } catch (e) {
        res.json({ online: false, playerCount: 0, maxPlayers: 0 });
    }
});

// ─── API: Create PIX Payment ────────────────────────────────────────────────
app.post('/api/pix/create', purchaseLimiter, async (req, res) => {
    const { playerName, itemId } = req.body;

    if (!playerName || !itemId) {
        return res.status(400).json({ error: 'Nome do jogador e item são obrigatórios' });
    }

    const item = STORE_ITEMS.pix[itemId];
    if (!item) {
        return res.status(404).json({ error: 'Item não encontrado' });
    }

    const purchaseId = crypto.randomUUID();
    const txid = 'MPX' + Date.now().toString(36).toUpperCase();
    const pixPayload = generatePixPayload(item.price, txid, item.name);

    storeDb.run(
        `INSERT INTO purchases (id, player_name, item_id, item_name, price, pix_txid, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [purchaseId, playerName, itemId, item.name, item.price, txid]
    );
    saveDb();

    let qrCodeDataUrl = null;
    try {
        qrCodeDataUrl = await qrcode.toDataURL(pixPayload, { width: 300, margin: 2 });
    } catch (e) {
        console.warn('[QR] Error:', e.message);
    }

    res.json({
        purchaseId,
        item: item.name,
        price: item.price,
        pixPayload,
        qrCode: qrCodeDataUrl,
        txid,
        expiresIn: 1800
    });
});

// ─── API: PIX Status ────────────────────────────────────────────────────────
app.get('/api/pix/status/:purchaseId', (req, res) => {
    const { purchaseId } = req.params;
    const purchase = queryOne(storeDb, 'SELECT * FROM purchases WHERE id = ?', [purchaseId]);

    if (!purchase) {
        return res.status(404).json({ error: 'Compra não encontrada' });
    }

    res.json({
        status: purchase.status,
        item: purchase.item_name,
        price: purchase.price,
        createdAt: purchase.created_at,
        paidAt: purchase.paid_at,
        deliveredAt: purchase.delivered_at
    });
});

// ─── API: Confirm PIX ───────────────────────────────────────────────────────
app.post('/api/pix/confirm/:purchaseId', (req, res) => {
    const { purchaseId } = req.params;
    const purchase = queryOne(storeDb, 'SELECT * FROM purchases WHERE id = ?', [purchaseId]);

    if (!purchase) {
        return res.status(404).json({ error: 'Compra não encontrada' });
    }

    if (purchase.status !== 'pending') {
        return res.json({ status: purchase.status, message: 'Pagamento já processado' });
    }

    storeDb.run(`UPDATE purchases SET status = 'paid', paid_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?`, [purchaseId]);
    saveDb();

    res.json({ status: 'paid', message: 'Pagamento confirmado!' });
});

// ─── API: Buy with MobCoins ─────────────────────────────────────────────────
app.post('/api/mobcoins/buy', purchaseLimiter, (req, res) => {
    const { playerName, itemId } = req.body;

    if (!playerName || !itemId) {
        return res.status(400).json({ error: 'Nome do jogador e item são obrigatórios' });
    }

    const item = STORE_ITEMS.mobcoins[itemId];
    if (!item) {
        return res.status(404).json({ error: 'Item não encontrado' });
    }

    const purchaseId = crypto.randomUUID();

    storeDb.run(
        `INSERT INTO mobcoins_purchases (id, player_name, item_id, item_name, cost, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [purchaseId, playerName, itemId, item.name, item.cost]
    );
    saveDb();

    res.json({
        purchaseId,
        item: item.name,
        cost: item.cost,
        status: 'pending',
        message: 'Use /mobcoins no servidor para completar a compra!'
    });
});

// ─── API: Purchases History ─────────────────────────────────────────────────
app.get('/api/purchases/:playerName', (req, res) => {
    const { playerName } = req.params;
    const pix = queryAll(storeDb, 'SELECT * FROM purchases WHERE player_name = ? ORDER BY created_at DESC LIMIT 20', [playerName]);
    const mobcoins = queryAll(storeDb, 'SELECT * FROM mobcoins_purchases WHERE player_name = ? ORDER BY created_at DESC LIMIT 20', [playerName]);
    res.json({ pix, mobcoins });
});

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// ─── Start ──────────────────────────────────────────────────────────────────
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════╗
║  Minepex Legends - Store API                     ║
║  Port: ${PORT}                                    ║
║  PIX Key: ${PIX_KEY.substring(0, 20)}...    ║
╚══════════════════════════════════════════════════╝
        `);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
