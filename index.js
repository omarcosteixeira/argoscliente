//#region ARGO'S - WhatsApp & API Bridge (Multi-Device)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const pino = require('pino'); 
require('dotenv').config();

// --- PROTEÇÃO GLOBAL CONTRA QUEDAS ---
process.on('uncaughtException', (err) => {
    console.error('[ERRO CRÍTICO NÃO TRATADO]:', err?.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROMISE REJEITADA NÃO TRATADA]:', reason?.message || reason);
});

process.on('SIGTERM', () => {
    console.log('\n[SISTEMA] Sinal SIGTERM recebido do Railway. Salvando estado e encerrando com segurança...');
    process.exit(0);
});

// --- DIRETÓRIO BASE ---
const authBaseFolder = './auth';
if (!fs.existsSync(authBaseFolder)) {
    fs.mkdirSync(authBaseFolder, { recursive: true });
}

// --- SERVIDOR EXPRESS ---
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.status(200).send("ARGO'S MULTI-DEVICE SYSTEM ONLINE!");
});

// --- PROMPT DA IA ---
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

const botInstances = {};

// --- PROCESSADOR DE FILA ---
async function processQueue(botNumber) {
    const instance = botInstances[botNumber];
    if (!instance || instance.isDeleted) return;

    while (instance.sendQueue && instance.sendQueue.length > 0) {
        if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;

        if (instance.status !== 'online' || !instance.sock) {
            console.log(`[FILA] Bot ${botNumber} está offline. Fila em pausa. A aguardar...`);
            await delay(5000);
            continue; 
        }

        const { jid, text } = instance.sendQueue.shift();
        
        try {
            const waitTime = 2000 + Math.floor(Math.random() * 2000);
            await delay(waitTime);

            let targetJid = jid;
            try {
                const [waStatus] = await instance.sock.onWhatsApp(jid);
                if (waStatus && waStatus.exists) {
                    targetJid = waStatus.jid; 
                }
            } catch (errCheck) {
                console.log(`[AVISO] Falha ao verificar número na Meta. Tentando entrega direta...`);
            }

            await instance.sock.sendMessage(targetJid, { text });
            console.log(`[DISPARO] Mensagem entregue a ${targetJid} via bot ${botNumber} | Restam: ${instance.sendQueue.length}`);
        } catch (e) {
            console.error(`[ERRO DISPARO] Falha ao enviar para ${jid}:`, e.message || e);
            if (e.message && e.message.toLowerCase().includes('closed') && botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
                botInstances[botNumber].sendQueue.unshift({ jid, text });
            }
        }
    }
    
    if (botInstances[botNumber]) {
        botInstances[botNumber].isProcessingQueue = false;
    }
}

// --- INICIALIZADOR DO BOT ---
async function startBot(botNumber, isExplicit = false) {
    
    // BLOQUEIO FANTASMA: Lápide
    if (!isExplicit && botInstances[botNumber] && botInstances[botNumber].isDeleted) {
        return;
    }

    if (botInstances[botNumber] && (botInstances[botNumber].status === 'initializing' || botInstances[botNumber].status === 'pairing') && !botInstances[botNumber].isDeleted) {
        return;
    }

    if (botInstances[botNumber] && botInstances[botNumber].sock && botInstances[botNumber].status === 'online') {
        return;
    }

    if (isExplicit && botInstances[botNumber] && botInstances[botNumber].isDeleted) {
        delete botInstances[botNumber];
    }

    console.log(`[BOT] Iniciando ligação para o número: ${botNumber}...`);
    
    const authFolder = `${authBaseFolder}/${botNumber}`;
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    if (!botInstances[botNumber]) {
        botInstances[botNumber] = {
            sock: null,
            isAutoReplyActive: false, 
            sessions: {},
            status: 'initializing',
            pairingCode: null,
            qr: null,
            sendQueue: [], 
            isProcessingQueue: false,
            isDeleted: false 
        };
    } else {
        botInstances[botNumber].status = 'initializing';
        botInstances[botNumber].isDeleted = false;
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), 
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'], // DISFARCE DE LINUX PARA BURLAR O BLOQUEIO
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000, 
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false, 
            markOnlineOnConnect: false 
        });

        if (botInstances[botNumber]) botInstances[botNumber].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered) {
            if (botInstances[botNumber]) botInstances[botNumber].status = 'pairing';
            
            setTimeout(async () => {
                if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;

                try {
                    const code = await sock.requestPairingCode(botNumber);
                    if (botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
                        botInstances[botNumber].pairingCode = code;
                        console.log(`\n=== CÓDIGO PARA ${botNumber}: ${code} ===\n`);
                    }
                } catch (error) {
                    console.error(`[ERRO] Falha ao solicitar código para ${botNumber}:`, error.message);
                    if (botInstances[botNumber]) botInstances[botNumber].status = 'error';
                }
            }, 6000);
        }

        sock.ev.on('connection.update', (update) => {
            if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;

            const { connection, lastDisconnect, qr } = update;

            if (qr && botInstances[botNumber]) {
                botInstances[botNumber].qr = qr; 
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                if (botInstances[botNumber]) botInstances[botNumber].status = 'offline';
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                
                if (isRestartRequired) {
                    if (botInstances[botNumber]) botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber, false), 2000); 
                } 
                else if (isLogout) {
                    console.log(`[SISTEMA] A Meta recusou a ligação (Erro ${statusCode}). Limpando memória...`);
                    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e) {}
                    if (botInstances[botNumber]) botInstances[botNumber].isDeleted = true;
                } else {
                    if (botInstances[botNumber]) botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber, false), 5000); 
                }
            } else if (connection === 'open') {
                if (botInstances[botNumber]) {
                    botInstances[botNumber].status = 'online';
                    botInstances[botNumber].pairingCode = null; 
                    botInstances[botNumber].qr = null; 
                }
                console.log(`\n--- ARGO\'S ONLINE: ${botNumber} ---\n`);
            }
        });

        sock.ev.on("messages.upsert", async m => {
            if (m.type !== "notify") return;
            let msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;
            
            const messageTimestamp = msg.messageTimestamp;
            if (messageTimestamp) {
                const nowInSeconds = Math.floor(Date.now() / 1000);
                if (nowInSeconds - messageTimestamp > 60) return; 
            }

            if (!botInstances[botNumber] || !botInstances[botNumber].isAutoReplyActive || botInstances[botNumber].isDeleted) return;

            const jid = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text) return;

            await handleAIProcess(botNumber, jid, text);
        });

    } catch (error) {
        if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;
        if (botInstances[botNumber]) {
            botInstances[botNumber].status = 'error';
            botInstances[botNumber].sock = null; 
        }
        setTimeout(() => startBot(botNumber, false), 10000);
    }
}

// --- INTEGRAÇÃO IA GROQ ---
async function handleAIProcess(botNumber, jid, text) {
    const instance = botInstances[botNumber];
    if (!instance || instance.isDeleted) return; 

    if (!instance.sessions[jid]) instance.sessions[jid] = { chat: [], lastActive: Date.now() };
    
    const session = instance.sessions[jid];
    session.lastActive = Date.now(); 
    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 10) session.chat.shift();

    const apiKey = process.env.GROQ_API_KEY || "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";
    if (!apiKey || apiKey.trim() === "") return;

    try {
        const groq = new Groq({ apiKey: apiKey });
        await instance.sock.sendPresenceUpdate("composing", jid);
        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6
        });
        const reply = response.choices[0]?.message?.content || "Estou a processar a sua dúvida.";
        session.chat.push({ role: "assistant", content: reply });
        await delay(Math.min(reply.length * 15, 3000));
        
        if (botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
            await instance.sock.sendMessage(jid, { text: reply });
        }
    } catch (err) {
        console.error(`[ERRO AI]:`, err.message || err);
    }
}

// --- LIMPEZA DE MEMÓRIA (GARBAGE COLLECTOR) ---
setInterval(() => {
    const now = Date.now();
    for (const botNumber of Object.keys(botInstances)) {
        const instance = botInstances[botNumber];
        if (instance && instance.sessions && !instance.isDeleted) {
            for (const [jid, session] of Object.entries(instance.sessions)) {
                if (now - session.lastActive > 1800000) delete instance.sessions[jid];
            }
        }
    }
}, 600000);

// --- ROTAS DA API ---
function formatNumberBR(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (clean.length === 13 && clean.substring(0, 2) === clean.substring(2, 4)) clean = clean.substring(2);
    if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) clean = '55' + clean;
    return clean;
}

app.post('/api/connect', async (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });
    const cleanNumber = formatNumberBR(botNumber);
    
    // true indica que é uma chamada manual para forçar o arranque!
    await startBot(cleanNumber, true); 
    
    res.json({ success: true, message: `Processo iniciado para ${
