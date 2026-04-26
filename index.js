require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

// ─────────────────────────────────────────────
// CONFIG — edit these to match your Discord setup
// ─────────────────────────────────────────────
const CONFIG = {
  // The Discord category name that contains all your client channels
  // e.g. "BOOST CLIENTS" — must match exactly (case-insensitive check done below)
  CLIENT_CATEGORY_NAME: 'CLIENTS (Boost-2)',

  // Discord role names
  CLIENT_ROLE: 'Boost Member',  // Role assigned to every client
  TEAM_ROLE: 'Admin',           // Role assigned to every team member

  // Active hours (IST = UTC+5:30)
  // Bot only starts a timer if client messages lands within these hours
  ACTIVE_HOURS_START: 9,    // 9am IST
  ACTIVE_HOURS_END: 22,     // 10pm IST

  // Notion database ID — already created for you
  NOTION_DATABASE_ID: '9cc417ffbad94afabf2f4e40b78b46ef',

  // Scoring rules
  SCORE: {
    UNDER_30: 2,    // +2 points for reply under 30 min
    UNDER_45: 1,    // +1 point for reply 30–45 min
    OVER_45: -1,    // -1 point for reply over 45 min
  }
};

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

// ─────────────────────────────────────────────
// STATE — tracks pending client messages waiting for a reply
// Key: channelId, Value: { clientName, messageTime, messageId }
// ─────────────────────────────────────────────
const pendingReplies = new Map();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function isActiveHour() {
  const now = new Date();
  // Convert UTC to IST (UTC+5:30)
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const hour = ist.getUTCHours();
  return hour >= CONFIG.ACTIVE_HOURS_START && hour < CONFIG.ACTIVE_HOURS_END;
}

function formatTime(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

function getResponseStats(responseMinutes) {
  if (responseMinutes < 30) {
    return { sla: '✅ Under 30 min', points: CONFIG.SCORE.UNDER_30 };
  } else if (responseMinutes <= 45) {
    return { sla: '⚠️ 30–45 min', points: CONFIG.SCORE.UNDER_45 };
  } else {
    return { sla: '🔴 Over 45 min', points: CONFIG.SCORE.OVER_45 };
  }
}

function isClientChannel(channel) {
  if (!channel.parent) return false;
  return channel.parent.name.toUpperCase() === CONFIG.CLIENT_CATEGORY_NAME.toUpperCase();
}

async function isTeamMember(member) {
  if (!member) return false;
  return member.roles.cache.some(r => r.name === CONFIG.TEAM_ROLE);
}

async function isClient(member) {
  if (!member) return false;
  return member.roles.cache.some(r => r.name === CONFIG.CLIENT_ROLE);
}

function getTeamMemberName(member) {
  // Try nickname first, then username
  // Map Discord usernames to Meteoric team names if needed
  const NAME_MAP = {
    // 'discordUsername': 'Meteoric Name'
    // e.g. 'adityav': 'Aditya',
    // Fill these in once you know your team's Discord usernames
  };
  const username = member.user.username;
  return NAME_MAP[username] || member.nickname || member.user.displayName || username;
}

// ─────────────────────────────────────────────
// LOG TO NOTION
// ─────────────────────────────────────────────

async function logToNotion({ clientName, date, clientMessageTime, firstReplyTime, responseMinutes, repliedBy, slaStatus, points, activeHours }) {
  try {
    await notion.pages.create({
      parent: { database_id: CONFIG.NOTION_DATABASE_ID },
      properties: {
        'Client Name': { title: [{ text: { content: clientName } }] },
        'Date': { date: { start: date } },
        'Client Message Time': { rich_text: [{ text: { content: clientMessageTime } }] },
        'First Reply Time': { rich_text: [{ text: { content: firstReplyTime } }] },
        'Response Time (mins)': { number: responseMinutes },
        'Replied By': { select: { name: repliedBy } },
        'SLA Status': { select: { name: slaStatus } },
        'Points': { number: points },
        'Active Hours?': { checkbox: activeHours },
      }
    });
    console.log(`✅ Logged: ${clientName} | ${responseMinutes}min | ${repliedBy} | ${slaStatus}`);
  } catch (err) {
    console.error('❌ Notion log failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// BOT EVENTS
// ─────────────────────────────────────────────

discord.once('ready', () => {
  console.log(`🚀 Meteoric Response Tracker is online as ${discord.user.tag}`);
});

discord.on('messageCreate', async (message) => {
  console.log(`📨 Message from: ${message.author.username} in #${message.channel.name} | Category: ${message.channel.parent?.name || 'none'}`);

  // Ignore bots
  if (message.author.bot) return;

  // Only watch client channels
  if (!isClientChannel(message.channel)) {
    console.log(`⏭ Skipping - not a client channel`);
    return;
  }

  const channelId = message.channel.id;

  // Fetch member to check roles
  const member = message.guild?.members.cache.get(message.author.id)
    || await message.guild?.members.fetch(message.author.id).catch(() => null);

  if (!member) return;

  const isTeam = await isTeamMember(member);
  const isClientMsg = await isClient(member);

  // ── CLIENT SENT A MESSAGE ──
  if (isClientMsg) {
    // Only start a timer if within active hours
    if (!isActiveHour()) {
      console.log(`⏰ Message from ${message.channel.name} outside active hours — skipping timer`);
      return;
    }

    // If there's already a pending reply for this channel, don't overwrite
    // (we track first unanswered message per channel)
    if (!pendingReplies.has(channelId)) {
      const clientName = message.channel.name
        .replace('1-on-1-', '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase()); // e.g. "1-on-1-dev-shah" → "Dev Shah"

      pendingReplies.set(channelId, {
        clientName,
        messageTime: message.createdAt,
        messageId: message.id,
      });

      console.log(`⏳ Timer started: ${clientName} at ${formatTime(message.createdAt)}`);
    }
    return;
  }

  // ── TEAM MEMBER REPLIED ──
  if (isTeam && pendingReplies.has(channelId)) {
    const pending = pendingReplies.get(channelId);
    const replyTime = message.createdAt;
    const diffMs = replyTime - pending.messageTime;
    const diffMins = Math.round(diffMs / 60000);

    const { sla, points } = getResponseStats(diffMins);
    const repliedBy = getTeamMemberName(member);

    const dateStr = replyTime.toISOString().split('T')[0]; // YYYY-MM-DD

    await logToNotion({
      clientName: pending.clientName,
      date: dateStr,
      clientMessageTime: formatTime(pending.messageTime),
      firstReplyTime: formatTime(replyTime),
      responseMinutes: diffMins,
      repliedBy,
      slaStatus: sla,
      points,
      activeHours: true,
    });

    // Clear the pending timer for this channel
    pendingReplies.delete(channelId);
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
discord.login(process.env.DISCORD_TOKEN);
