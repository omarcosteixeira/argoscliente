//#region ARGO'S - WhatsApp & API Bridge (Multi-Device)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const pino = require('pino'); 
require('dotenv').config();

// --- PROTEÇÃO GLOBAL CONTRA CRASHES ---
process.on('uncaughtException', (err) => {
    console.error('[ERRO CRÍTICO NÃO TRATADO]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROMISE REJEITADA NÃO TRATADA]:', reason);
});

// --- DIRETÓRIO BASE DE AUTENTICAÇÃO ---
const authBaseFolder = './auth';
if (!fs.existsSync(authBaseFolder)) {
    fs.mkdirSync(authBaseFolder, { recursive: true });
}

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS ---
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors()); 
app.options('*', cors()); 
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ROTA DE SAÚDE RAIZ
app.get('/', (req, res) => {
    res.status(200).send("ARGO'S MULTI-DEVICE SYSTEM ONLINE!");
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

// =====================================================================
// 🤖 GESTOR DE MÚLTIPLOS BOTS (MULTI-DEVICE)
// =====================================================================
// Estrutura: { "5524999999999": { sock, isAutoReplyActive, sessions, status, pairingCode } }
const botInstances = {};

async function startBot(botNumber) {
    if (botInstances[botNumber] && botInstances[botNumber].sock) {
        console.log(`[SISTEMA] Bot ${botNumber} já está em execução.`);
        return;
    }

    console.log(`[BOT] Iniciando conexão para o número: ${botNumber}...`);
    
    const authFolder = `${authBaseFolder}/${botNumber}`;
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    botInstances[botNumber] = {
        sock: null,
        isAutoReplyActive: true,
        sessions: {},
        status: 'initializing',
        pairingCode: null
    };

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), 
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false, 
            markOnlineOnConnect: true
        });

        botInstances[botNumber].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        // --- SISTEMA DE EMPARELHAMENTO POR CÓDIGO ---
        if (!state.creds.registered) {
            botInstances[botNumber].status = 'pairing';
            console.log(`\n[SISTEMA] Preparando código de emparelhamento para: ${botNumber}...`);
            
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(botNumber);
                    botInstances[botNumber].pairingCode = code;
                    console.log(`\n======================================================`);
                    console.log(`🔐 CÓDIGO DE CONEXÃO PARA ${botNumber}: ${code}`);
                    console.log(`======================================================\n`);
                } catch (error) {
                    console.error(`[ERRO] Falha ao solicitar código para ${botNumber}:`, error);
                    botInstances[botNumber].status = 'error';
                }
            }, 4000);
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                botInstances[botNumber].status = 'offline';
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`[CONEXÃO - ${botNumber}] Fechada. Reconectando: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(() => startBot(botNumber), 5000); 
                } else {
                    // Se foi deslogado (saiu no celular), limpa a pasta para poder conectar de novo no futuro
                    console.log(`[SISTEMA] Dispositivo ${botNumber} foi desconectado manualmente.`);
                    fs.rmSync(authFolder, { recursive: true, force: true });
                    delete botInstances[botNumber];
                }
            } else if (connection === 'open') {
                botInstances[botNumber].status = 'online';
                botInstances[botNumber].pairingCode = null; // Limpa o código pois já conectou
                console.log(`--- ARGO\'S ONLINE PARA O NÚMERO: ${botNumber} ---`);
            }
        });

        sock.ev.on("messages.upsert", async m => {
            if (m.type !== "notify") return;
            let msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;
            
            if (!botInstances[botNumber].isAutoReplyActive) return;

            const jid = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text) return;

            await handleAIProcess(botNumber, jid, text);
        });

    } catch (error) {
        console.error(`[ERRO CRÍTICO] Falha ao iniciar o bot ${botNumber}:`, error);
        botInstances[botNumber].status = 'error';
        setTimeout(() => startBot(botNumber), 10000);
    }
}

async function handleAIProcess(botNumber, jid, text) {
    const instance = botInstances[botNumber];
    if (!instance.sessions[jid]) instance.sessions[jid] = { chat: [] };
    
    const session = instance.sessions[jid];
    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 10) session.chat.shift();

    try {
        await instance.sock.sendPresenceUpdate("composing", jid);
        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6
        });
        const reply = response.choices[0]?.message?.content || "Estou processando sua dúvida.";
        session.chat.push({ role: "assistant", content: reply });
        await delay(Math.min(reply.length * 15, 3000));
        await instance.sock.sendMessage(jid, { text: reply });
    } catch (err) {
        console.error(`[ERRO AI - ${botNumber}]:`, err);
    }
}

// =====================================================================
// 🌐 ROTAS DA API PARA O SITE DE GESTÃO (GESTAOPRO)
// =====================================================================

// 1. CONECTAR NOVO NÚMERO (Gera Código de Emparelhamento)
app.post('/api/connect', async (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });

    const cleanNumber = botNumber.replace(/\D/g, '');
    await startBot(cleanNumber);
    
    res.json({ 
        success: true, 
        message: `Processo de conexão iniciado para ${cleanNumber}. Verifique a rota /api/status para obter o código de emparelhamento.` 
    });
});

// 2. ENVIAR MENSAGEM (Agora exige especificar de qual bot a mensagem vai sair)
app.post('/api/send', async (req, res) => {
    const { botNumber, number, message } = req.body;
    
    if (!botNumber || !number || !message) {
        return res.status(400).json({ error: "Campos 'botNumber', 'number' e 'message' são obrigatórios." });
    }

    const instance = botInstances[botNumber];
    if (!instance || !instance.sock || instance.status !== 'online') {
        return res.status(503).json({ error: `O bot ${botNumber} não está conectado.` });
    }

    const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
        await instance.sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: "Mensagem enviada com sucesso!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. LIGAR/DESLIGAR IA POR NÚMERO
app.post('/api/toggle', (req, res) => {
    const { botNumber, active } = req.body;
    
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });
    
    if (botInstances[botNumber]) {
        botInstances[botNumber].isAutoReplyActive = active === true;
        res.json({ success: true, botNumber, active: botInstances[botNumber].isAutoReplyActive });
    } else {
        res.status(404).json({ error: `Bot ${botNumber} não encontrado.` });
    }
});

// 4. STATUS GLOBAL (Lista todos os bots, se estão online e os códigos de emparelhamento gerados)
app.get('/api/status', (req, res) => {
    const statusData = {};
    for (const [number, instance] of Object.entries(botInstances)) {
        statusData[number] = {
            status: instance.status,
            autoReply: instance.isAutoReplyActive,
            pairingCode: instance.pairingCode // O site pega este código para exibir ao usuário
        };
    }

    res.json({ 
        system: "ARGO'S MULTI-DEVICE", 
        uptime: process.uptime(),
        bots: statusData
    });
});

// ESCUTA O SERVIDOR E AUTO-LOADER
app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] API Multi-Device rodando em 0.0.0.0:${PORT}`);
    
    // Auto-Loader: Lê a pasta authBaseFolder e tenta ligar todos os números que já estavam registrados
    setTimeout(() => {
        try {
            const folders = fs.readdirSync(authBaseFolder);
            folders.forEach(folder => {
                // Verifica se a pasta tem apenas números (formato de telefone)
                if (/^\d+$/.test(folder)) {
                    console.log(`[AUTO-LOADER] Inicializando sessão guardada para: ${folder}`);
                    startBot(folder);
                }
            });
        } catch (e) {
            console.log("[AUTO-LOADER] Nenhuma sessão anterior encontrada.");
        }
    }, 5000);
});
