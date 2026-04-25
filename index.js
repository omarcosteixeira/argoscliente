//#region ARGO'S - WhatsApp & API Bridge (Angra dos Reis)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// --- CONFIGURAÇÃO DO SERVIDOR EXPRESS (PONTE PARA O SITE) ---
const app = express();

// Configuração de CORS - DEVE SER POSICIONADO ANTES DE QUALQUER ROTA OU MIDDLEWARE JSON
app.use(cors()); 
app.use(express.json());

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
2. Use as informações do site gestaopro-five.vercel.app para ajudar os clientes.
3. Mantenha um tom profissional, tecnológico e ágil.
4. Respostas curtas e objetivas (estilo WhatsApp).
5. Se o atendimento automático estiver desativado no sistema, você não deve responder.
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
    });

    botState.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("\n==========================================");
            console.log("APONTE O WHATSAPP PARA O ARGO'S");
            console.log("==========================================");
            
            // Tenta gerar no terminal
            qrcode.generate(qr, { small: true });

            // GERAÇÃO DE LINK EXTERNO (Caso o terminal falhe)
            const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`\n⚠️ SE O QR CODE ACIMA NÃO ESTIVER VISÍVEL OU DISTORCIDO, CLIQUE NO LINK:`);
            console.log(linkQrCode);
            console.log("==========================================\n");
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startArgos();
        } else if (connection === 'open') {
            console.log('\n--- ARGO\'S ONLINE: CONEXÃO ESTABELECIDA (ANGRA DOS REIS) ---\n');
        }
    });

    // Ouvinte de Mensagens Recebidas
    sock.ev.on("messages.upsert", async m => {
        if (m.type !== "notify") return;
        let msg = m.messages[0];
        
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;

        // VERIFICAÇÃO DE ATENDIMENTO AUTOMÁTICO (Toggle do Site)
        if (!botState.isAutoReplyActive) return;

        const jid = msg.key.remoteJid;
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || "";

        if (!text) return;

        await handleAIProcess(jid, text);
    });
}

// Processamento da IA
async function handleAIProcess(jid, text) {
    if (!botState.sessions[jid]) botState.sessions[jid] = { chat: [] };
    const session = botState.sessions[jid];

    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 15) session.chat.shift();

    try {
        await botState.sock.sendPresenceUpdate("composing", jid);

        const response = await groq.chat.completions.create({
            messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.6
        });

        const reply = response.choices[0]?.message?.content || "Estou a processar a sua dúvida.";
        session.chat.push({ role: "assistant", content: reply });

        // Delay para parecer humano
        const typingTime = Math.min(reply.length * 15, 5000);
        await delay(typingTime);
        
        await botState.sock.sendMessage(jid, { text: reply });

    } catch (err) {
        console.error("Erro na IA:", err);
    }
}

// --- ROTAS DA API (PONTE PARA O SITE) ---

// Enviar mensagem manual (Pelo botão do site)
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
        await botState.sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ligar/Desligar IA (Toggle no site)
app.post('/api/toggle', (req, res) => {
    botState.isAutoReplyActive = req.body.active === true;
    res.json({ success: true, isAutoReplyActive: botState.isAutoReplyActive });
});

// Status do Sistema
app.get('/api/status', (req, res) => {
    res.json({ name: "ARGO'S", online: !!botState.sock?.user, autoReply: botState.isAutoReplyActive });
});

// Escuta em 0.0.0.0 para garantir visibilidade externa no Railway
app.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] Ponte ARGO'S rodando na porta ${PORT}`);
});

startArgos();
