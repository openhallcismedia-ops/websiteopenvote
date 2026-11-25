/**
 * Open Hall Web Backend
 * Поддержка браузерных пользователей + модерация через Telegram Bot API + Chief AI (Groq)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_ID = (process.env.ADMIN_CHAT_ID || process.env.ADMIN_ID || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// --- Файловое хранилище (data/) ---
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadJsonSafe(filePath, defaultVal) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2), 'utf-8');
      return defaultVal;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[Storage] Read error ${filePath}:`, err.message);
    return defaultVal;
  }
}

function saveToFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[Storage] Write error ${filePath}:`, err.message);
  }
}

function escapeTgHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let projectsData = loadJsonSafe(PROJECTS_FILE, [
  {
    id: "proj_default",
    name: "Open Hall",
    description: "A community showcase where everyday people rate bold ideas, apps, and creative projects from 1 to 10.",
    tags: [],
    screenshots: [],
    status: "approved",
    created_at: new Date().toISOString()
  }
]);
let reviewsData = loadJsonSafe(REVIEWS_FILE, []);
let usersData = loadJsonSafe(USERS_FILE, {});

function resolveUser(guestId, guestName) {
  if (guestId && typeof guestId === 'string' && guestId.trim().length >= 4) {
    const cleanId = guestId.trim().slice(0, 64);
    return {
      id: cleanId,
      name: (guestName && guestName.trim()) ? guestName.trim().slice(0, 30) : `Guest #${cleanId.slice(-4)}`
    };
  }
  return null;
}

// --- ОТПРАВКА УВЕДОМЛЕНИЙ И АЛЬБОМОВ СКРИНШОТОВ В TELEGRAM ---
async function sendTelegramNotification(text, replyMarkup = null, screenshots = []) {
  if (!BOT_TOKEN || !ADMIN_ID) return false;

  const validList = Array.isArray(screenshots)
    ? screenshots.filter(s => typeof s === 'string' && s.startsWith('data:image/'))
    : (typeof screenshots === 'string' && screenshots.startsWith('data:image/') ? [screenshots] : []);

  if (validList.length === 1) {
    try {
      const base64Data = validList[0].split(',')[1];
      const fileBuffer = Buffer.from(base64Data, 'base64');
      const boundary = '----OpenHallBoundary' + Date.now().toString(16);
      const safeCaption = text.length > 1000 ? text.slice(0, 995) + '...' : text;

      const parts = [];
      const addField = (name, val) => {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
          'utf-8'
        ));
      };

      addField('chat_id', ADMIN_ID);
      addField('caption', safeCaption);
      addField('parse_mode', 'HTML');
      if (replyMarkup) addField('reply_markup', JSON.stringify(replyMarkup));

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot_1.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        'utf-8'
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));

      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts)
      });

      const data = await res.json();
      if (data.ok) return true;
    } catch (e) {}
  }

  if (validList.length > 1) {
    try {
      const boundary = '----OpenHallAlbum' + Date.now().toString(16);
      const parts = [];
      const addField = (name, val) => {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
          'utf-8'
        ));
      };

      const mediaArray = validList.map((_, idx) => ({
        type: 'photo',
        media: `attach://photo_${idx}`
      }));

      addField('chat_id', ADMIN_ID);
      addField('media', JSON.stringify(mediaArray));

      validList.forEach((b64, idx) => {
        const base64Data = b64.split(',')[1];
        const fileBuffer = Buffer.from(base64Data, 'base64');
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="photo_${idx}"; filename="screenshot_${idx + 1}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
          'utf-8'
        ));
        parts.push(fileBuffer);
        parts.push(Buffer.from('\r\n', 'utf-8'));
      });

      parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts)
      });
    } catch (e) {}
  }

  try {
    const payload = {
      chat_id: ADMIN_ID,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data.ok;
  } catch (err) {
    return false;
  }
}

// --- API РОУТЫ ---

app.get('/api/projects', (req, res) => {
  const approved = projectsData.filter(p => p.status === 'approved');
  res.json(approved);
});

app.post('/api/projects', async (req, res) => {
  const { guestId, guestName, name, description, screenshots, screenshot } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: 'Name and description required' });
  }

  const exists = projectsData.some(p => p.name.toLowerCase() === name.trim().toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Project already exists' });
  }

  const user = resolveUser(guestId, guestName);
  const userId = user ? user.id : null;
  const userProfile = userId && usersData[userId] ? usersData[userId] : null;

  let validScreenshots = [];
  if (Array.isArray(screenshots)) {
    validScreenshots = screenshots
      .filter(s => typeof s === 'string' && s.startsWith('data:image/') && s.length < 2500000)
      .slice(0, 3);
  } else if (typeof screenshot === 'string' && screenshot.startsWith('data:image/') && screenshot.length < 2500000) {
    validScreenshots = [screenshot];
  }

  const projectId = `proj_${Date.now()}`;
  const authorName = userProfile?.custom_handle || user?.name || 'Creator';

  const newProj = {
    id: projectId,
    name: name.trim(),
    description: description.trim(),
    tags: [],
    screenshots: validScreenshots,
    screenshot: validScreenshots[0] || null,
    status: 'pending',
    submitted_by: userId,
    author_name: authorName,
    created_at: new Date().toISOString()
  };

  projectsData.unshift(newProj);
  saveToFile(PROJECTS_FILE, projectsData);

  const msgText = `🚀 <b>New Project Submission (Web)!</b>\n\n` +
    `📌 <b>Name:</b> ${escapeTgHtml(newProj.name)}\n` +
    `📝 <b>Description:</b> ${escapeTgHtml(newProj.description)}\n` +
    `🖼 <b>Screenshots:</b> ${validScreenshots.length}\n` +
    `👤 <b>Author:</b> ${escapeTgHtml(authorName)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve_proj_${projectId}` },
        { text: '❌ Reject', callback_data: `reject_proj_${projectId}` }
      ]
    ]
  };

  await sendTelegramNotification(msgText, keyboard, validScreenshots);
  res.status(201).json({ status: 'ok', project: newProj });
});

app.post('/api/review', async (req, res) => {
  const { guestId, guestName, project, score, verdict, comment } = req.body;
  if (!project || score === undefined) {
    return res.status(400).json({ error: 'Project and score required' });
  }

  const user = resolveUser(guestId, guestName);
  const userId = user ? user.id : null;
  const userProfile = userId && usersData[userId] ? usersData[userId] : null;

  const reviewId = `rev_${Date.now()}`;
  const authorName = userProfile?.custom_handle || user?.name || 'Reviewer';

  const newReview = {
    id: reviewId,
    project: String(project),
    score: Number(score),
    verdict: verdict || 'Community Approved',
    comment: String(comment || '').trim(),
    status: 'pending',
    user_id: userId,
    author_name: authorName,
    created_at: new Date().toISOString()
  };

  reviewsData.unshift(newReview);
  saveToFile(REVIEWS_FILE, reviewsData);

  const msgText = `⭐ <b>New Rating Submission (Web)!</b>\n\n` +
    `📌 <b>Project:</b> ${escapeTgHtml(newReview.project)}\n` +
    `🔢 <b>Score:</b> ${newReview.score} / 10 (${escapeTgHtml(newReview.verdict)})\n` +
    `💬 <b>Comment:</b> ${escapeTgHtml(newReview.comment || 'No comment')}\n` +
    `👤 <b>Author:</b> ${escapeTgHtml(authorName)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve_rev_${reviewId}` },
        { text: '❌ Reject', callback_data: `reject_rev_${reviewId}` }
      ]
    ]
  };

  await sendTelegramNotification(msgText, keyboard);
  res.status(201).json({ status: 'ok', review: newReview });
});

app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;

  if (update?.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const isPhotoMessage = Boolean(cb.message?.photo);
    const originalText = cb.message?.caption || cb.message?.text || '';

    let responseText = '';

    if (data.startsWith('approve_proj_')) {
      const pId = data.replace('approve_proj_', '');
      const p = projectsData.find(item => item.id === pId);
      if (p) {
        p.status = 'approved';
        saveToFile(PROJECTS_FILE, projectsData);
        responseText = `✅ Project «${p.name}» APPROVED and published!`;
      }
    } else if (data.startsWith('reject_proj_')) {
      const pId = data.replace('reject_proj_', '');
      const p = projectsData.find(item => item.id === pId);
      if (p) {
        p.status = 'rejected';
        saveToFile(PROJECTS_FILE, projectsData);
        responseText = `❌ Project «${p.name}» REJECTED.`;
      }
    } else if (data.startsWith('approve_rev_')) {
      const rId = data.replace('approve_rev_', '');
      const r = reviewsData.find(item => item.id === rId);
      if (r) {
        r.status = 'approved';
        saveToFile(REVIEWS_FILE, reviewsData);
        responseText = `✅ Review for «${r.project}» APPROVED!`;
      }
    } else if (data.startsWith('reject_rev_')) {
      const rId = data.replace('reject_rev_', '');
      const r = reviewsData.find(item => item.id === rId);
      if (r) {
        r.status = 'rejected';
        saveToFile(REVIEWS_FILE, reviewsData);
        responseText = `❌ Review for «${r.project}» REJECTED.`;
      }
    }

    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: responseText })
      });

      if (chatId && messageId && responseText) {
        const updatedText = `${escapeTgHtml(originalText)}\n\n<b>Verdict:</b> ${escapeTgHtml(responseText)}`;
        const endpoint = isPhotoMessage ? 'editMessageCaption' : 'editMessageText';
        const bodyPayload = {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        };
        if (isPhotoMessage) bodyPayload.caption = updatedText;
        else bodyPayload.text = updatedText;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload)
        });
      }
    } catch (e) {}
  }

  res.sendStatus(200);
});

app.get('/api/reviews', (req, res) => {
  const projectName = req.query.project;
  if (!projectName) return res.json([]);
  const list = reviewsData.filter(r =>
    r.project.toLowerCase() === projectName.toLowerCase() &&
    r.status === 'approved'
  );
  res.json(list);
});

app.get('/api/leaderboard', (req, res) => {
  const stats = {};
  const approvedReviews = reviewsData.filter(r => r.status === 'approved');

  approvedReviews.forEach(r => {
    if (!stats[r.project]) stats[r.project] = { sum: 0, count: 0 };
    stats[r.project].sum += r.score;
    stats[r.project].count += 1;
  });

  const leaderboard = Object.keys(stats).map(projectName => {
    const avg = (stats[projectName].sum / stats[projectName].count).toFixed(1);
    return {
      project_name: projectName,
      avg_score: Number(avg),
      total_votes: stats[projectName].count
    };
  });

  leaderboard.sort((a, b) => b.avg_score - a.avg_score || b.total_votes - a.total_votes);
  res.json(leaderboard);
});

app.get('/api/profile', (req, res) => {
  const user = resolveUser(req.query.guestId, req.query.guestName);
  if (!user) return res.json({ available: false });

  const userId = user.id;
  const profile = usersData[userId] || {
    name: user.name,
    custom_handle: user.name
  };

  const userReviews = reviewsData.filter(r => r.user_id === userId && r.status === 'approved');
  const userProjects = projectsData.filter(p => p.submitted_by === userId);

  res.json({
    available: true,
    user: profile,
    reviews_count: userReviews.length,
    projects_submitted: userProjects.length
  });
});

app.post('/api/profile/custom', (req, res) => {
  const { guestId, guestName, custom_handle } = req.body;
  const user = resolveUser(guestId, guestName);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = user.id;
  usersData[userId] = {
    name: custom_handle || user.name,
    custom_handle: custom_handle || user.name
  };

  saveToFile(USERS_FILE, usersData);
  res.json({ status: 'ok', user: usersData[userId] });
});

app.get('/api/profile/my-content', (req, res) => {
  const user = resolveUser(req.query.guestId, req.query.guestName);
  const type = req.query.type;
  if (!user) return res.json({ items: [] });

  const userId = user.id;
  if (type === 'projects') {
    const list = projectsData.filter(p => p.submitted_by === userId);
    return res.json({ items: list });
  } else {
    const list = reviewsData.filter(r => r.user_id === userId);
    return res.json({ items: list });
  }
});

app.get('/api/user/:id', (req, res) => {
  const userId = String(req.params.id);
  const profile = usersData[userId] || { name: 'Community Member' };
  const userReviews = reviewsData.filter(r => r.user_id === userId && r.status === 'approved');
  const userProjects = projectsData.filter(p => p.submitted_by === userId && p.status === 'approved');

  res.json({
    name: profile.custom_handle || profile.name,
    reviews_count: userReviews.length,
    projects_count: userProjects.length
  });
});

app.post('/api/agent/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  if (!GROQ_API_KEY) {
    return res.json({
      available: true,
      reply: "GROQ_API_KEY is not configured on the server."
    });
  }

  try {
    const systemPrompt = `You are Chief, the official AI guide of Open Hall — an open community platform where everyday people discover, rate, and review bold ideas, apps, and creative projects from 1 to 10.
Your goals:
1. Help creators craft punchy titles and clear, engaging descriptions for their ideas.
2. Explain the 4 simple rating criteria: Idea & Value, Design & UX, Execution, and Overall Vibe.
3. Give concise, friendly, and practical feedback.
4. Always reply in natural, conversational English.`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      history.slice(-8).forEach(h => {
        messages.push({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: String(h.content || '')
        });
      });
    }
    messages.push({ role: 'user', content: String(message) });

    const models = [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-8b-8192',
      'gemma2-9b-it'
    ];

    for (const model of models) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.7,
            max_tokens: 800
          })
        });

        const data = await response.json();
        if (response.ok && data?.choices?.[0]?.message?.content) {
          return res.json({ available: true, reply: data.choices[0].message.content });
        }
      } catch (err) {}
    }

    return res.json({
      available: true,
      reply: "Chief is taking a quick coffee break. Try again in a moment!"
    });
  } catch (err) {
    res.json({
      available: true,
      reply: "Connection error with Chief."
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Open Hall Web Server] Running on port ${PORT}`);
});
