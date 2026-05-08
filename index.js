//#region ARGO'S - WhatsApp & API Bridge (Multi-Device)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay, Browsers } = require('@whiskeysockets/baileys');
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

process.on('SIGTERM', () => {
    console.log('\n[SISTEMA] Sinal SIGTERM recebido do Railway. O servidor está a ser reiniciado ou forçado a parar.');
    process.exit(0);
});

// --- DIRETÓRIO BASE DE AUTENTICAÇÃO ---
const authBaseFolder = './auth';
if (!fs.existsSync(authBaseFolder)) {
    fs.mkdirSync(authBaseFolder, { recursive: true });
}

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS ---
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

// --- CONFIGURAÇÃO DA IA GROQ ---
// A inicialização global foi removida. A IA agora só é carregada dentro da função handleAIProcess 
// para garantir que o servidor (disparos e WhatsApp) arranca sempre, mesmo sem chave.

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
// 🤖 GESTOR DE MÚLTIPLOS BOTS E FILA DE MENSAGENS (MULTI-DEVICE)
// =====================================================================
const botInstances = {};

async function processQueue(botNumber) {
    const instance = botInstances[botNumber];
    if (!instance) return;

    while (instance.sendQueue && instance.sendQueue.length > 0) {
        if (instance.status !== 'online' || !instance.sock) {
            console.log(`[FILA] Bot ${botNumber} está offline (Erro 503). Fila em pausa. A aguardar...`);
            await delay(5000);
            continue; 
        }

        const { jid, text } = instance.sendQueue.shift();
        
        try {
            const waitTime = 2000 + Math.floor(Math.random() * 2000);
            await delay(waitTime);

            const [waStatus] = await instance.sock.onWhatsApp(jid);

            if (waStatus && waStatus.exists) {
                await instance.sock.sendMessage(waStatus.jid, { text });
                console.log(`[DISPARO] Mensagem entregue a ${waStatus.jid} via bot ${botNumber} | Restam: ${instance.sendQueue.length}`);
            } else {
                console.log(`[AVISO] O número ${jid} não tem WhatsApp ou é inválido. Disparo ignorado.`);
            }
        } catch (e) {
            console.error(`[ERRO DISPARO] Falha ao enviar para ${jid}:`, e.message || e);
            if (e.message && e.message.toLowerCase().includes('closed')) {
                instance.sendQueue.unshift({ jid, text });
            }
        }
    }
    
    instance.isProcessingQueue = false;
}

async function startBot(botNumber) {
    if (botInstances[botNumber] && botInstances[botNumber].sock) {
        console.log(`[SISTEMA] Bot ${botNumber} já está em execução.`);
        return;
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
            isProcessingQueue: false
        };
    } else {
        botInstances[botNumber].status = 'initializing';
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), 
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'), 
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000, 
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false, 
            markOnlineOnConnect: false 
        });

        botInstances[botNumber].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered) {
            botInstances[botNumber].status = 'pairing';
            console.log(`\n[SISTEMA] A preparar autenticação para: ${botNumber}...`);
            
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(botNumber);
                    botInstances[botNumber].pairingCode = code;
                    console.log(`\n======================================================`);
                    console.log(`🔐 CÓDIGO DE LIGAÇÃO PARA ${botNumber}: ${code}`);
                    console.log(`⚠️ ATENÇÃO: Se o WhatsApp avisar sobre "Login Suspeito",`);
                    console.log(`   clique em "Fui eu" antes de inserir o código!`);
                    console.log(`======================================================\n`);
                } catch (error) {
                    console.error(`[ERRO] Falha ao solicitar código para ${botNumber}:`, error);
                    botInstances[botNumber].status = 'error';
                }
            }, 4000);
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                botInstances[botNumber].qr = qr; 
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                botInstances[botNumber].status = 'offline';
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                
                if (isRestartRequired) {
                    console.log(`[LIGAÇÃO - ${botNumber}] O WhatsApp solicitou um reinício. A reconectar imediatamente...`);
                    botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber), 2000);
                } else if (!isLogout) {
                    console.log(`[LIGAÇÃO - ${botNumber}] Fechada. Código: ${statusCode}. A tentar reconectar em 5s...`);
                    botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber), 5000); 
                } else {
                    console.log(`[SISTEMA - ${botNumber}] O dispositivo terminou a sessão ou foi bloqueado por segurança.`);
                    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e) {}
                    delete botInstances[botNumber];
                }
            } else if (connection === 'open') {
                botInstances[botNumber].status = 'online';
                botInstances[botNumber].pairingCode = null; 
                botInstances[botNumber].qr = null; 
                console.log(`\n--- ARGO\'S ONLINE PARA O NÚMERO: ${botNumber} ---\n`);
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
        botInstances[botNumber].sock = null; 
        setTimeout(() => startBot(botNumber), 10000);
    }
}

async function handleAIProcess(botNumber, jid, text) {
    const instance = botInstances[botNumber];
    if (!instance.sessions[jid]) instance.sessions[jid] = { chat: [] };
    
    const session = instance.sessions[jid];
    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 10) session.chat.shift();

    // ⚠️ VERIFICAÇÃO SEGURA DA CHAVE NO MOMENTO DA RESPOSTA ⚠️
    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.trim() === "") {
        console.error(`[AVISO AI - ${botNumber}]: IA não respondeu. Nenhuma variável 'GROQ_API_KEY' foi encontrada no Railway.`);
        return;
    }

    try {
        // Inicializa a IA somente aqui! Se falhar, não afeta o resto do sistema.
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        
        await instance.sock.sendPresenceUpdate("composing", jid);
        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6
        });
        const reply = response.choices[0]?.message?.content || "Estou a processar a sua dúvida.";
        session.chat.push({ role: "assistant", content: reply });
        await delay(Math.min(reply.length * 15, 3000));
        await instance.sock.sendMessage(jid, { text: reply });
    } catch (err) {
        console.error(`[ERRO AI - ${botNumber}]:`, err.message || err);
    }
}

// =====================================================================
// 🌐 ROTAS DA API PARA O SITE DE GESTÃO (GESTAOPRO)
// =====================================================================

function formatNumberBR(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (clean.length === 13 && clean.substring(0, 2) === clean.substring(2, 4)) {
        clean = clean.substring(2);
    }
    if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) {
        clean = '55' + clean;
    }
    return clean;
}

app.post('/api/connect', async (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });

    const cleanNumber = formatNumberBR(botNumber);
    await startBot(cleanNumber);
    
    res.json({ success: true, message: `Processo de ligação iniciado para ${cleanNumber}.` });
});

app.post('/api/send', (req, res) => {
    const { botNumber, number, message } = req.body;
    
    if (!botNumber || !number || !message) {
        return res.status(400).json({ error: "Os campos 'botNumber', 'number' e 'message' são obrigatórios." });
    }

    const cleanBotNumber = formatNumberBR(botNumber);
    const instance = botInstances[cleanBotNumber];
    
    if (!instance || !instance.sock || instance.status !== 'online') {
        return res.status(503).json({ error: `O bot ${cleanBotNumber} não está ligado.` });
    }

    const cleanRecipient = formatNumberBR(number);
    const jid = `${cleanRecipient}@s.whatsapp.net`;

    if (!instance.sendQueue) instance.sendQueue = [];
    instance.sendQueue.push({ jid, text: message });

    if (!instance.isProcessingQueue) {
        instance.isProcessingQueue = true;
        processQueue(cleanBotNumber);
    }

    res.json({ success: true, message: `Adicionado à fila. Faltam processar: ${instance.sendQueue.length}` });
});

app.post('/api/toggle', (req, res) => {
    const { botNumber, active } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });
    
    const cleanBotNumber = formatNumberBR(botNumber);

    if (botInstances[cleanBotNumber]) {
        botInstances[cleanBotNumber].isAutoReplyActive = active === true;
        res.json({ success: true, botNumber: cleanBotNumber, active: botInstances[cleanBotNumber].isAutoReplyActive });
    } else {
        res.status(404).json({ error: `Bot ${cleanBotNumber} não encontrado.` });
    }
});

app.post('/api/reset', (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });

    const cleanNumber = formatNumberBR(botNumber);
    const authFolder = `${authBaseFolder}/${cleanNumber}`;
    
    try {
        if (botInstances[cleanNumber] && botInstances[cleanNumber].sock) {
            botInstances[cleanNumber].sock.logout().catch(() => {});
            botInstances[cleanNumber].sock.end(undefined);
        }
        
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
        }
        
        delete botInstances[cleanNumber];
        res.json({ success: true, message: `A sessão corrompida de ${cleanNumber} foi apagada.` });
    } catch (error) {
        res.status(500).json({ error: "Erro ao tentar limpar a sessão: " + error.message });
    }
});

app.get('/api/status', (req, res) => {
    const statusData = {};
    for (const [number, instance] of Object.entries(botInstances)) {
        statusData[number] = {
            status: instance.status,
            autoReply: instance.isAutoReplyActive,
            pairingCode: instance.pairingCode,
            qrCode: instance.qr, 
            qrUrl: instance.qr ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(instance.qr)}` : null,
            queueLength: instance.sendQueue ? instance.sendQueue.length : 0
        };
    }

    res.json({ 
        system: "ARGO'S MULTI-DEVICE", 
        uptime: process.uptime(),
        bots: statusData
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] API Multi-Device a correr em 0.0.0.0:${PORT}`);
    
    setTimeout(() => {
        try {
            const folders = fs.readdirSync(authBaseFolder);
            folders.forEach(folder => {
                if (/^\d+$/.test(folder)) {
                    console.log(`[AUTO-LOADER] A inicializar sessão guardada para: ${folder}`);
                    startBot(folder);
                }
            });
        } catch (e) {
            console.log("[AUTO-LOADER] Nenhuma sessão anterior encontrada.");
        }
    }, 5000);
});
