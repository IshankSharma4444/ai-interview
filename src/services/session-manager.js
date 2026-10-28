const DEFAULT_SESSIONS = [];

function createSession(id) {
  return {
    id: id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    messages: [],
    summary: '',
    lastUpdatedAt: Date.now()
  };
}

class SessionManager {
  constructor() {
    this.sessions = [];
    this.activeSessionId = null;
    this.init();
  }

  init() {
    this.sessions = [createSession()];
    this.activeSessionId = this.sessions[0].id;
    return this.getState();
  }

  getActiveSession() {
    if (!this.sessions || this.sessions.length === 0) {
      const s = createSession();
      this.sessions = [s];
      this.activeSessionId = s.id;
      return s;
    }
    return this.sessions.find((s) => s.id === this.activeSessionId) || this.sessions[0];
  }

  getState() {
    const active = this.getActiveSession();
    return {
      sessions: this.sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastUpdatedAt: s.lastUpdatedAt,
        messageCount: s.messages ? s.messages.length : 0,
        summary: s.summary
      })),
      activeSessionId: active ? active.id : null,
      messages: active && Array.isArray(active.messages) ? active.messages : []
    };
  }

  getMessagesForRequest() {
    const active = this.getActiveSession();
    if (!active || !Array.isArray(active.messages)) return [];
    return active.messages
      .filter((m) => m && m.role && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content.trim()
      }));
  }

  addMessage(role, content) {
    const active = this.getActiveSession();
    if (!active) return;
    active.messages.push({ role, content, timestamp: Date.now() });
    active.lastUpdatedAt = Date.now();
  }

  newSession() {
    const session = createSession();
    this.sessions.push(session);
    this.activeSessionId = session.id;
    return this.getState();
  }

  switchSession(sessionId) {
    const exists = this.sessions.find((s) => s.id === sessionId);
    if (!exists) return this.getState();
    this.activeSessionId = sessionId;
    return this.getState();
  }

  clearActiveContext() {
    const active = this.getActiveSession();
    if (!active) return this.getState();
    active.messages = [];
    active.summary = '';
    active.lastUpdatedAt = Date.now();
    return this.getState();
  }
}

module.exports = { SessionManager, createSession };
