require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

const CONFIG = {
  CLIENT_CATEGORY_NAME: 'CLIENTS (Boost-2)',
  CLIENT_ROLE: 'Boost Member',
  TEAM_ROLE: 'Admin',
  ACTIVE_HOURS_START: 9,
  ACTIVE_HOURS_END: 22,
  NOTION_DATABASE_ID: '9cc417ffbad94afabf2f4e40b78b46ef',
  SCORE: { UNDER_30: 2, UNDER_45: 1, OVER_45: -1 }
};

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const pendingReplies = new Map();
const todayStats = {};

function isActiveHour() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const hour = ist.getUTCHours();
  return hour >= CONFIG.ACTIVE_HOURS_START && hour < CONFIG.ACTIVE_HOURS_END;
}

function formatTime(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
}

function getResponseStats(mins) {
  if (mins < 30) return { sla: 'Under 30 min', points: CONFIG.SCORE.UNDER_30 };
  if (mins <= 45) return { sla: '30-45 min', points: CONFIG.SCORE.UNDER_45 };
  return { sla: 'Over 45 min', points: CONFIG.SCORE.OVER_45 };
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
  const NAME_MAP = {};
  const username = member.user.username;
  return NAME_MAP[username] || member.nickname || member.user.displayName || username;
}

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
    console.log('Logged: ' + clientName + ' | ' + responseMinutes + 'min | ' + repliedBy);
  } catch (err) {
    console.error('Notion log failed: ' + err.message);
  }
}

function recordStat({ repliedBy, responseMinutes, points, clientName }) {
  if (!todayStats[repliedBy]) {
    todayStats[repliedBy] = { responses: 0, totalMins: 0, points: 0, breaches: 0, fastest: null };
  }
  const s = todayStats[repliedBy];
  s.responses++;
  s.totalMins += responseMinutes;
  s.points += points;
  if (points < 0) s.breaches++;
  if (!s.fastest || responseMinutes < s.fastest.mins) {
    s.fastest = { mins: responseMinutes, client: clientName };
  }
}

async function postDailyScorecard() {
  console.log('postDailyScorecard called');
  let targetChannel = null;
  discord.guilds.cache.forEach(function(guild) {
    guild.channels.cache.forEach(function(ch) {
      if (ch.name.toLowerCase().indexOf('turnaround') !== -1 && ch.parent && ch.parent.name.toUpperCase() === 'TEAM METEORIC') {
        targetChannel = ch;
      }
    });
  });

  if (!targetChannel) {
    console.log('Turnaround channel not found');
    return;
  }

  console.log('Turnaround channel found: ' + targetChannel.name);
  const today = new Date();
  const ist = new Date(today.getTime() + (5.5 * 60 * 60 * 1000));
  const dateStr = ist.toISOString().split('T')[0];
  const ranked = Object.entries(todayStats).sort(function(a, b) { return b[1].points - a[1].points; });

  if (ranked.length === 0) {
    await targetChannel.send('No client responses tracked today. Date: ' + dateStr);
    return;
  }

  let msg = 'Daily Response Scorecard ' + dateStr + '\n\n';
  ranked.forEach(function(entry, i) {
    const name = entry[0];
    const s = entry[1];
    const avg = Math.round(s.totalMins / s.responses);
    msg += (i + 1) + '. ' + name + ' - ' + s.responses + ' responses | Avg ' + avg + ' min | ' + s.points + ' pts\n';
  });

  await targetChannel.send(msg);
  console.log('Scorecard posted');
  Object.keys(todayStats).forEach(function(k) { delete todayStats[k]; });
}

function scheduleScorecard() {
  function msUntil10pmIST() {
    const now = new Date();
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const target = new Date(ist);
    target.setUTCHours(16, 30, 0, 0);
    if (target <= ist) target.setUTCDate(target.getUTCDate() + 1);
    return target - ist;
  }
  function loop() {
    const delay = msUntil10pmIST();
    console.log('Next scorecard in ' + Math.round(delay / 60000) + ' minutes');
    setTimeout(async function() {
      await postDailyScorecard();
      loop();
    }, delay);
  }
  loop();
}

discord.once('ready', function() {
  console.log('Bot online as ' + discord.user.tag);
  scheduleScorecard();
});

discord.on('messageCreate', async function(message) {
  console.log('MSG: ' + message.author.username + ' | ' + message.channel.name + ' | ' + message.content.substring(0, 20));

  if (message.author.bot) return;

  if (message.content.toLowerCase().indexOf('scorecard') !== -1) {
    console.log('SCORECARD TRIGGERED');
    await postDailyScorecard();
    return;
  }

  if (!isClientChannel(message.channel)) {
    return;
  }

  const channelId = message.channel.id;
  const member = message.guild.members.cache.get(message.author.id) || await message.guild.members.fetch(message.author.id).catch(function() { return null; });
  if (!member) return;

  const isTeam = await isTeamMember(member);
  const isClientMsg = await isClient(member);

  if (isClientMsg) {
    if (!isActiveHour()) {
      console.log('Outside active hours');
      return;
    }
    if (!pendingReplies.has(channelId)) {
      const clientName = message.channel.name.replace('1-on-1-', '').replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
      pendingReplies.set(channelId, { clientName: clientName, messageTime: message.createdAt, messageId: message.id });
      console.log('Timer started for ' + clientName);
    }
    return;
  }

  if (isTeam && pendingReplies.has(channelId)) {
    const pending = pendingReplies.get(channelId);
    const replyTime = message.createdAt;
    const diffMins = Math.round((replyTime - pending.messageTime) / 60000);
    const stats = getResponseStats(diffMins);
    const repliedBy = getTeamMemberName(member);
    const dateStr = replyTime.toISOString().split('T')[0];

    await logToNotion({
      clientName: pending.clientName,
      date: dateStr,
      clientMessageTime: formatTime(pending.messageTime),
      firstReplyTime: formatTime(replyTime),
      responseMinutes: diffMins,
      repliedBy: repliedBy,
      slaStatus: stats.sla,
      points: stats.points,
      activeHours: true,
    });

    recordStat({ repliedBy: repliedBy, responseMinutes: diffMins, points: stats.points, clientName: pending.clientName });
    pendingReplies.delete(channelId);
  }
});

discord.login(process.env.DISCORD_TOKEN);
