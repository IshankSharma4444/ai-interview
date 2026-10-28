function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim().length > 0)
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
      content: msg.content.trim()
    }));
}

async function callGroq({ apiKey, model, messages }) {
  const cleanMessages = sanitizeMessages(messages);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'llama-3.3-70b-versatile', messages: cleanMessages, temperature: 0.7 })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, headers: res.headers, data, text };
}

async function callGemini({ apiKey, model, messages }) {
  const m = model || 'gemini-1.5-flash';
  const cleanMessages = sanitizeMessages(messages);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const contents = cleanMessages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, headers: res.headers, data, text };
}

async function callOpenAI({ apiKey, model, messages }) {
  const cleanMessages = sanitizeMessages(messages);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: cleanMessages, temperature: 0.7 })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, headers: res.headers, data, text };
}

function parseGroq(resp) {
  if (!resp.ok) return null;
  const content = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
  return content || null;
}

function parseGemini(resp) {
  if (!resp.ok) return null;
  const content = resp.data && resp.data.candidates && resp.data.candidates[0] && resp.data.candidates[0].content && resp.data.candidates[0].content.parts && resp.data.candidates[0].content.parts[0] && resp.data.candidates[0].content.parts[0].text;
  return content || null;
}

function parseOpenAI(resp) {
  if (!resp.ok) return null;
  const content = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && resp.data.choices[0].message.content;
  return content || null;
}

const providers = {
  groq: { call: callGroq, parse: parseGroq, defaultModel: 'openai/gpt-oss-120b' },
  gemini: { call: callGemini, parse: parseGemini, defaultModel: 'gemini-3.8-flash' },
  openai: { call: callOpenAI, parse: parseOpenAI, defaultModel: 'gpt-4o-mini' }
};

module.exports = { providers };
