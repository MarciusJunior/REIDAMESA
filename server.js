import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tmi from "tmi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, "db.json");

const app = express();
app.use(cors());
app.use(express.json());

// ===========================
// CONFIG ENV
// ===========================
// Crie um bot na Twitch e use:
// TWITCH_BOT_USERNAME=seu_bot_username
// TWITCH_OAUTH_TOKEN=oauth:xxxxxxxxxxxx
const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME || "";
const OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN || "";
const PORT = process.env.PORT || 3000;

// ===========================
// STATE
// ===========================
let state = {
  channel: "",              // ex: tealzlol
  ranking: {},              // { user: points }
  joined: {},               // { user: true } -> já entrou no sistema
  currentBets: {},          // { user: 1|2 } apostas da rodada atual
  lastRound: null           // info da última rodada
};

if (fs.existsSync(DB_FILE)) {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}

function parseChannelFromUrl(twitchUrl = "") {
  try {
    const u = new URL(twitchUrl);
    if (!u.hostname.includes("twitch.tv")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    return parts[0].toLowerCase();
  } catch {
    return null;
  }
}

// ===========================
// TWITCH CLIENT
// ===========================
let client = null;
let connectedChannel = "";

async function connectToChannel(channel) {
  if (!BOT_USERNAME || !OAUTH_TOKEN) {
    throw new Error("Configure TWITCH_BOT_USERNAME e TWITCH_OAUTH_TOKEN no backend.");
  }

  // recria conexão se já existir
  if (client) {
    try { await client.disconnect(); } catch {}
    client = null;
  }

  client = new tmi.Client({
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN
    },
    channels: [channel]
  });

  client.on("message", (channelName, tags, message, self) => {
    if (self) return;
    const user = (tags["display-name"] || tags.username || "").toLowerCase();
    const msg = (message || "").trim().toLowerCase();

    if (!user) return;

    // !entrar
    if (msg === "!entrar") {
      state.joined[user] = true;
      if (state.ranking[user] == null) state.ranking[user] = 0;
      saveDB();
      return;
    }

    // !aposta 1 / !aposta 2
    if (msg === "!aposta 1" || msg === "!aposta 2") {
      // só pode apostar quem entrou antes
      if (!state.joined[user]) return;
      const side = msg.endsWith("1") ? 1 : 2;
      state.currentBets[user] = side;
      saveDB();
      return;
    }
  });

  await client.connect();
  connectedChannel = channel;
}

function top100() {
  return Object.entries(state.ranking)
    .map(([user, points]) => ({ user, points }))
    .sort((a, b) => b.points - a.points || a.user.localeCompare(b.user))
    .slice(0, 100);
}

// ===========================
// API
// ===========================

// health
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    channel: state.channel,
    connectedChannel
  });
});

// conectar canal por URL
app.post("/api/connect-channel", async (req, res) => {
  try {
    const { twitchUrl } = req.body || {};
    const channel = parseChannelFromUrl(twitchUrl);
    if (!channel) return res.status(400).json({ error: "Link da Twitch inválido." });

    await connectToChannel(channel);

    state.channel = channel;
    saveDB();

    res.json({ ok: true, channel });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao conectar canal." });
  }
});

// ranking
app.get("/api/ranking", (_req, res) => {
  res.json({ top: top100() });
});

// fechar rodada
// body: { winnerSide: 1|2, player1, player2 }
app.post("/api/resolve-round", (req, res) => {
  try {
    const { winnerSide, player1, player2 } = req.body || {};
    if (winnerSide !== 1 && winnerSide !== 2) {
      return res.status(400).json({ error: "winnerSide precisa ser 1 ou 2." });
    }

    let winnersCount = 0;
    const losers = [];

    for (const [user, bet] of Object.entries(state.currentBets)) {
      if (bet === winnerSide) {
        state.ranking[user] = (state.ranking[user] || 0) + 10;
        winnersCount++;
      } else {
        losers.push(user);
      }
    }

    state.lastRound = {
      winnerSide,
      winnerName: winnerSide === 1 ? (player1 || "Player 1") : (player2 || "Player 2"),
      winnersCount,
      losersCount: losers.length,
      at: new Date().toISOString()
    };

    // limpa apostas para a próxima rodada
    state.currentBets = {};
    saveDB();

    res.json({ ok: true, winnersCount, top: top100() });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao fechar rodada." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
