//#region ARGO'S - WhatsApp & API Bridge (Angra dos Reis)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS (PONTE PARA O SITE) ---
const app = express();
app.use(express.json());
app.use(cors()); // Essencial para o site gestaopro-five.vercel.app conseguir acessar a API

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DA IA GROQ ---
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "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"
});

// Prompt de Sistema refinado para o ARGO'S
const PROMPT_ARGOS = `Você é o ARGO'S, o assistente virtual inteligente oficial.
Unidade: Angra dos Reis.
Site de Gestão: gestaopro-five.vercel.app

Diretrizes de Resposta:
1. Sempre se apresente como ARGO'S da unidade Angra dos Reis.
2. Seu objetivo é entender as mensagens e usar as informações do site gestaopro-five.vercel.app para ajudar.
3. Mantenha um tom profissional, tecnológico e ágil.
4. Respostas curtas e objetivas (estilo WhatsApp).
5. Se o atendimento automático estiver desativado no sistema, você não deve processar a resposta.
6. Nunca invente dados de pedidos. Direcione o cliente para o painel do site se necessário.`;

// --- ESTADO GLOBAL DO BOT ---
let botState = {
    sock: null,
    isAutoReplyActive: true, // Controlado via API pelo botão no seu site
    sessions: {}
};

async function startArgos() {
    console.log("Iniciando ARGO'S System...");
    
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth/bot');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["ARGO'S System", "Chrome", "1.0.0"],
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        }
    });

    botState.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n==========================================");
            console.log("APONTE O WHATSAPP PARA O QR CODE DO ARGO'S");
            console.log("==========================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("Reconectando ARGO'S...");
                startArgos();
            }
        } else if (connection === 'open') {
            console.log('\n--- ARGO\'S ONLINE: CONEXÃO ESTABELECIDA (ANGRA DOS REIS) ---\n');
        }
    });

    // Ouvinte de Mensagens Recebidas
    sock.ev.on("messages.upsert", async m => {
        if (m.type !== "notify") return;
        let msg = m.messages[0];
        
        // Filtros: ignora mensagens próprias, de grupos ou vazias
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;

        // VERIFICAÇÃO DE ATENDIMENTO AUTOMÁTICO (Botão no Site)
        if (!botState.isAutoReplyActive) {
            console.log("Mensagem recebida, mas ARGO'S está em modo MANUAL (IA Desativada).");
            return;
        }

        const jid = msg.key.remoteJid;
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || "";

        if (!text) return;

        await handleAIProcess(jid, text);
    });
}

// Processamento da Inteligência Artificial
async function handleAIProcess(jid, text) {
    if (!botState.sessions[jid]) botState.sessions[jid] = { chat: [] };
    const session = botState.sessions[jid];

    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 15) session.chat.shift(); // Mantém histórico curto

    try {
        await botState.sock.sendPresenceUpdate("composing", jid);

        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6,
            max_tokens: 500
        });

        const reply = response.choices[0]?.message?.content || "Estou processando sua dúvida, um momento.";
        session.chat.push({ role: "assistant", content: reply });

        // Simulação de tempo de digitação humana
        const typingTime = Math.min(reply.length * 15, 5000);
        await delay(typingTime);
        
        await botState.sock.sendMessage(jid, { text: reply });

    } catch (err) {
        console.error("Erro Groq/AI:", err);
    }
}

// =====================================================================
// 🌉 ROTAS DA API (PONTE PARA O SITE GESTAOPRO-FIVE)
// =====================================================================

// 1. Enviar mensagem manual (Chamado quando você clica em botões no seu site)
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: "Número e mensagem são obrigatórios." });

    // Formata o número para o padrão JID do WhatsApp
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    
    try {
        if (!botState.sock) throw new Error("Bot não inicializado.");
        await botState.sock.sendMessage(jid, { text: message });
        res.json({ success: true, status: "Mensagem enviada via ARGO'S Bridge" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Ligar/Desligar atendimento automático (Toggle via Site)
app.post('/api/toggle', (req, res) => {
    const { active } = req.body; // Espera true ou false
    botState.isAutoReplyActive = active === true;
    
    console.log(`[SISTEMA] Atendimento automático alterado para: ${botState.isAutoReplyActive ? 'ATIVO' : 'DESATIVADO'}`);
    res.json({ success: true, isAutoReplyActive: botState.isAutoReplyActive });
});

// 3. Status de saúde do sistema
app.get('/api/status', (req, res) => {
    res.json({ 
        name: "ARGO'S", 
        unit: "Angra dos Reis",
        online: !!(botState.sock && botState.sock.user),
        autoReply: botState.isAutoReplyActive,
        version: "1.1.0"
    });
});

app.listen(PORT, () => {
    console.log(`[API] Ponte ARGO'S rodando na porta ${PORT}`);
});

startArgos();
