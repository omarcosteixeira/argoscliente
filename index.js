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

// --- DIRETÓRIO BASE DE AUTENTICAÇÃO ---
const authBaseFolder = './auth';
if (!fs.existsSync(authBaseFolder)) {
    fs.mkdirSync(authBaseFolder, { recursive: true });
}

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS ---
const app = express();
const PORT = process.env.PORT || 8080;

// --- CONFIGURAÇÃO DE CORS (CORRIGIDA) ---
// Removemos a duplicação de cabeçalhos que estava a causar o bloqueio no navegador
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ROTA DE SAÚDE RAIZ
app.get('/', (req, res) => {
    res.status(200).send("ARGO'S MULTI-DEVICE SYSTEM ONLINE!");
});

// --- CONFIGURAÇÃO DA IA GROQ ---
const groq = new Groq({
    // Lê do Railway primeiro. Se não achar, usa a sua chave nova diretamente!
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
// Estrutura: { "5524999999999": { sock, isAutoReplyActive, sessions, status, pairingCode, qr } }
const botInstances = {};

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
            // A IA AGORA INICIA DESLIGADA POR PADRÃO.
            // O seu painel deve enviar a requisição para a ligar.
            isAutoReplyActive: false, 
            sessions: {},
            status: 'initializing',
            pairingCode: null,
            qr: null
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
            // Retornado para Ubuntu/Chrome pois é o padrão mais estável para o Pairing Code
            browser: Browsers.ubuntu('Chrome'), 
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false, 
            markOnlineOnConnect: true
        });

        botInstances[botNumber].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        // --- SISTEMA DE EMPARELHAMENTO POR CÓDIGO E QR CODE ---
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

            // --- TRATAMENTO DO QR CODE ---
            if (qr) {
                botInstances[botNumber].qr = qr; 
                const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
                
                console.log(`\n======================================================`);
                console.log(`📱 QR CODE GERADO PARA ${botNumber}`);
                console.log(`Pode usar o código acima OU aceder ao link abaixo para digitalizar:`);
                console.log(`${linkQrCode}`);
                console.log(`======================================================\n`);
                
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                botInstances[botNumber].status = 'offline';
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                
                if (isRestartRequired) {
                    console.log(`[LIGAÇÃO - ${botNumber}] O WhatsApp solicitou um reinício (Código 515). A reconectar imediatamente...`);
                    botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber), 2000);
                } else if (!isLogout) {
                    console.log(`[LIGAÇÃO - ${botNumber}] Fechada. Código: ${statusCode}. A tentar reconectar em 5s...`);
                    botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber), 5000); 
                } else {
                    console.log(`[SISTEMA - ${botNumber}] O dispositivo terminou a sessão ou foi bloqueado por segurança (Erro ${statusCode}).`);
                    console.log(`[SISTEMA - ${botNumber}] A apagar sessão corrompida para evitar loop...`);
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
            
            // Se a IA estiver desligada (padrão), o bot não faz nada (ignora a mensagem automaticamente).
            if (!botInstances[botNumber].isAutoReplyActive) return;

            const jid = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text) return;

            await handleAIProcess(botNumber, jid, text);
        });

    } catch (error) {
        console.error(`[ERRO CRÍTICO] Falha ao iniciar o bot ${botNumber}:`, error);
        botInstances[botNumber].status = 'error';
        botInstances[botNumber].sock = null; // Assegura que pode tentar novamente
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

// 1. LIGAR NOVO NÚMERO (Gera Código de Emparelhamento)
app.post('/api/connect', async (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });

    const cleanNumber = botNumber.replace(/\D/g, '');
    await startBot(cleanNumber);
    
    res.json({ 
        success: true, 
        message: `Processo de ligação iniciado para ${cleanNumber}. Verifique a rota /api/status para obter o código de emparelhamento.` 
    });
});

// 2. ENVIAR MENSAGEM (Com Sistema de Fila para Disparos em Massa)
app.post('/api/send', (req, res) => {
    const { botNumber, number, message } = req.body;
    
    if (!botNumber || !number || !message) {
        return res.status(400).json({ error: "Os campos 'botNumber', 'number' e 'message' são obrigatórios." });
    }

    const instance = botInstances[botNumber];
    if (!instance || !instance.sock || instance.status !== 'online') {
        return res.status(503).json({ error: `O bot ${botNumber} não está ligado.` });
    }

    const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;

    // Cria a fila de envios se não existir para este bot
    if (!instance.sendQueue) {
        instance.sendQueue = Promise.resolve();
    }

    // Adiciona a mensagem à fila para ser processada em background
    instance.sendQueue = instance.sendQueue.then(async () => {
        try {
            // Atraso de segurança aleatório entre 1.5s e 3.5s (Impede que o WhatsApp bloqueie por Spam e o Railway trave)
            const waitTime = 1500 + Math.floor(Math.random() * 2000);
            await delay(waitTime);

            await instance.sock.sendMessage(jid, { text: message });
            console.log(`[DISPARO] Mensagem enviada para ${jid} via bot ${botNumber}`);
        } catch (e) {
            console.error(`[ERRO DISPARO] Falha ao enviar para ${jid}:`, e.message);
        }
    }).catch(err => console.error("Erro na fila de envio:", err));

    // O Servidor responde IMEDIATAMENTE ao seu site, sem esperar a mensagem sair do telemóvel.
    // Isto elimina para sempre o "Erro de rede / CORS / Offline" na sua tela.
    res.json({ success: true, message: "Mensagem adicionada à fila de disparo!" });
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

// 4. RESETAR SESSÃO CORROMPIDA (Remove erros de 'Bad MAC')
app.post('/api/reset', (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });

    const cleanNumber = botNumber.replace(/\D/g, '');
    const authFolder = `${authBaseFolder}/${cleanNumber}`;
    
    try {
        // Desliga a instância se estiver em loop/online
        if (botInstances[cleanNumber] && botInstances[cleanNumber].sock) {
            botInstances[cleanNumber].sock.logout().catch(() => {});
            botInstances[cleanNumber].sock.end(undefined);
        }
        
        // Apaga fisicamente a pasta de chaves corrompidas do Railway
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
        }
        
        // Remove da memória do bot
        delete botInstances[cleanNumber];
        
        console.log(`[SISTEMA] Sessão do número ${cleanNumber} foi limpa (Reset manual).`);
        res.json({ success: true, message: `A sessão corrompida de ${cleanNumber} foi completamente apagada. Pode gerar um novo código de ligação agora!` });
    } catch (error) {
        res.status(500).json({ error: "Erro ao tentar limpar a sessão: " + error.message });
    }
});

// 5. ESTADO GLOBAL (Lista todos os bots, se estão online e os códigos de emparelhamento gerados)
app.get('/api/status', (req, res) => {
    const statusData = {};
    for (const [number, instance] of Object.entries(botInstances)) {
        statusData[number] = {
            status: instance.status,
            autoReply: instance.isAutoReplyActive,
            pairingCode: instance.pairingCode,
            qrCode: instance.qr, // A string bruta do QR Code
            qrUrl: instance.qr ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(instance.qr)}` : null // Link direto para a imagem
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
    console.log(`[SERVER] API Multi-Device a correr em 0.0.0.0:${PORT}`);
    
    // Auto-Loader: Lê a pasta authBaseFolder e tenta ligar todos os números que já estavam registados
    setTimeout(() => {
        try {
            const folders = fs.readdirSync(authBaseFolder);
            folders.forEach(folder => {
                // Verifica se a pasta tem apenas números (formato de telefone)
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
