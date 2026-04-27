//#region ARGO'S - WhatsApp & API Bridge (Angra dos Reis)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const fs = require('fs'); // Biblioteca nativa para manipulação de arquivos
require('dotenv').config();

// --- PROTEÇÃO GLOBAL CONTRA CRASHES (Evita o erro 502 no Railway) ---
process.on('uncaughtException', (err) => {
    console.error('[ERRO CRÍTICO NÃO TRATADO]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROMISE REJEITADA NÃO TRATADA]:', reason);
});

// --- GARANTIR CRIAÇÃO DA PASTA DE AUTENTICAÇÃO ---
const authFolder = './auth/bot';
if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
    console.log(`[SISTEMA] Pasta ${authFolder} criada com sucesso para evitar crash do Baileys.`);
}

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS (INÍCIO IMEDIATO) ---
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de CORS robusta
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ROTA DE SAÚDE (FUNDAMENTAL PARA O RAILWAY NÃO DAR TIMEOUT)
app.get('/', (req, res) => {
    res.status(200).send("ARGO'S SYSTEM ONLINE E RESPONDENDO!");
});

// --- CONFIGURAÇÃO DA IA GROQ ---
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "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"
});

const PROMPT_ARGOS = `Você é o ARGO'S, o assistente virtual inteligente oficial.
Unidade: Angra dos Reis.
Site de Gestão: gestaopro-five.vercel.app

Diretrizes de Resposta:
1. Sempre se apresente como ARGO'S da unidade Angra dos Reis.
2. Use as informações do site gestaopro-five.vercel.app para ajudar os clientes.
3. Mantenha um tom profissional, tecnológico e ágil.
4. Respostas curtas e objetivas (estilo WhatsApp).
5. Se o atendimento automático estiver desativado no sistema, você não deve responder.
6. Nunca invente dados de pedidos. Direcione o cliente para o painel do site se necessário.`;

// --- ESTADO GLOBAL DO BOT ---
let botState = {
    sock: null,
    isAutoReplyActive: true,
    sessions: {}
};

async function startArgos() {
    console.log("[BOT] Iniciando conexão com o WhatsApp...");
    
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ["ARGO'S System", "Chrome", "1.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        botState.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log("\n==========================================");
                console.log("APONTE O WHATSAPP PARA O ARGO'S");
                const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
                console.log(`LINK DO QR CODE: ${linkQrCode}`);
                console.log("==========================================\n");
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`[CONEXÃO] Fechada. Motivo: ${lastDisconnect?.error}. Reconectando: ${shouldReconnect}`);
                if (shouldReconnect) startArgos();
            } else if (connection === 'open') {
                console.log('--- ARGO\'S ONLINE: ANGRA DOS REIS ---');
            }
        });

        sock.ev.on("messages.upsert", async m => {
            if (m.type !== "notify") return;
            let msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;
            if (!botState.isAutoReplyActive) return;

            const jid = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text) return;

            await handleAIProcess(jid, text);
        });

    } catch (error) {
        console.error("[ERRO CRÍTICO] Falha ao iniciar o bot:", error);
        setTimeout(startArgos, 10000);
    }
}

async function handleAIProcess(jid, text) {
    if (!botState.sessions[jid]) botState.sessions[jid] = { chat: [] };
    const session = botState.sessions[jid];
    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 10) session.chat.shift();

    try {
        await botState.sock.sendPresenceUpdate("composing", jid);
        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6
        });
        const reply = response.choices[0]?.message?.content || "Estou processando sua dúvida.";
        session.chat.push({ role: "assistant", content: reply });
        await delay(Math.min(reply.length * 15, 3000));
        await botState.sock.sendMessage(jid, { text: reply });
    } catch (err) {
        console.error("[ERRO AI]:", err);
    }
}

// --- ROTAS DA API ---

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    if (!botState.sock) return res.status(503).json({ error: "Bot desconectado." });
    const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
        await botState.sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/toggle', (req, res) => {
    botState.isAutoReplyActive = req.body.active === true;
    res.json({ success: true, active: botState.isAutoReplyActive });
});

app.get('/api/status', (req, res) => {
    res.json({ 
        name: "ARGO'S", 
        online: !!botState.sock?.user, 
        autoReply: botState.isAutoReplyActive,
        uptime: process.uptime()
    });
});

// ESCUTA O SERVIDOR (O HOST "0.0.0.0" É OBRIGATÓRIO NO RAILWAY)
app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] API Bridge rodando em 0.0.0.0:${PORT}`);
    
    // --- BOT RELIGADO ---
    // Como confirmamos que o servidor sobe normalmente e o problema era de URL no frontend,
    // religamos o bot para ele gerar o QR Code no Railway.
    setTimeout(() => {
        startArgos();
    }, 2000);
});
