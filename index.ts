import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  MessageUpsertType,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

// Configurations
const CONFIG = {
  sessionPath: "session_data",
  adminOnly: true,
  tagCommand: "!everyone",
  ownerNumber: "6281234567890", // Ganti dengan nomor Anda
  botName: "TagAll Bot",
  maxGroupMembers: 100 // Batas maksimal anggota grup yang bisa di-tag
};

// Logger setup
const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:dd-mm-yyyy HH:MM:ss",
      ignore: "pid,hostname"
    }
  }
});

async function connectToWhatsApp() {
  try {
    // Initialize auth state
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionPath);
    
    // Create socket connection
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      browser: [CONFIG.botName, "Safari", "1.0.0"]
    });

    // Save credentials when updated
    sock.ev.on("creds.update", saveCreds);

    // Handle connection updates
    sock.ev.on("connection.update", (update) => {
      if (update.qr) logger.info("Scan QR code to connect");
      if (update.connection === "open") logger.info("Connected successfully");
      
      if (update.connection === "close") {
        const shouldReconnect = (update.lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
      }
    });

    // Handle incoming messages
    sock.ev.on("messages.upsert", async (m: { messages: WAMessage[]; type: MessageUpsertType }) => {
      const message = m.messages[0];
      if (!message.message || message.key.fromMe || !message.message.conversation) return;
      
      const text = message.message.conversation.toLowerCase();
      const chatId = message.key.remoteJid!;
      const sender = message.key.participant || message.key.remoteJid!;
      const isGroup = chatId.endsWith("@g.us");
      
      if (!isGroup || text !== CONFIG.tagCommand) return;

      try {
        const groupData = await sock.groupMetadata(chatId);
        const isAdmin = groupData.participants.find(p => p.id === sender)?.admin === "admin";
        const isOwner = sender.split("@")[0] === CONFIG.ownerNumber.split("@")[0];
        
        // Permission check
        if (CONFIG.adminOnly && !isAdmin && !isOwner) {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa menggunakan command ini!" });
          return;
        }

        // Check group size
        if (groupData.participants.length > CONFIG.maxGroupMembers) {
          await sock.sendMessage(chatId, { 
            text: `❌ Grup ini terlalu besar (${groupData.participants.length} anggota). Maksimal ${CONFIG.maxGroupMembers} anggota.` 
          });
          return;
        }

        // Prepare mentions
        const mentionedJidList = groupData.participants.map(p => p.id);
        const mentionText = mentionedJidList.map(id => `@${id.split("@")[0]}`).join(" ");

        // Send single message with all mentions
        await sock.sendMessage(chatId, {
          text: `@everyone'@${sender.split("@")[0]}\n\n` +
                `${mentionText}`,
          mentions: [...mentionedJidList, sender]
        });

        logger.info(`Tag all successful in ${groupData.subject} (${mentionedJidList.length} members)`);

      } catch (error) {
        logger.error(`Tag all error: ${error}`);
        await sock.sendMessage(chatId, { 
          text: "⚠️ Gagal melakukan tag all. Mungkin grup terlalu besar atau ada masalah koneksi." 
        });
      }
    });

  } catch (error) {
    logger.error(`Initialization error: ${error}`);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// Start the bot
connectToWhatsApp();

// Handle process termination
process.on("SIGINT", () => {
  logger.info("Shutting down gracefully...");
  process.exit(0);
});
