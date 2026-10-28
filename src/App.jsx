import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const INITIAL_STATUS = {
  visible: false,
  overlayFocused: false,
  routingActive: false,
  routingFailures: [],
  foreground: null,
  captureProtected: false
};

const MAX_PROMPT = 4000;
const PROVIDERS = ['groq', 'gemini', 'openai'];

function parseAnswer(raw) {
  if (!raw) return { summary: '', points: [], notes: [] };
  const lines = raw.split('\n');
  let summary = '';
  const points = [];
  const notes = [];
  let isParsingPoints = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
      isParsingPoints = true;
      const cleaned = trimmed.replace(/^[•\-*]\s*|^\d+\.\s*/, '');
      const colonIdx = cleaned.indexOf(':');
      if (colonIdx > 0 && colonIdx < 35) {
        points.push({
          label: cleaned.slice(0, colonIdx).replace(/\*\*/g, '').trim(),
          content: cleaned.slice(colonIdx + 1).trim()
        });
      } else {
        points.push({ label: '', content: cleaned });
      }
    } else if (!isParsingPoints && !summary) {
      summary = trimmed.replace(/\*\*/g, '');
    } else {
      notes.push(trimmed);
    }
  }

  return {
    summary: summary || (points.length === 0 ? raw : ''),
    points,
    notes
  };
}

function formatTime(timestamp) {
  if (!timestamp) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function App() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [copiedId, setCopiedId] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [thumbsFeedback, setThumbsFeedback] = useState({}); // { [pairId]: 'up' | 'down' }

  const [provider, setProvider] = useState(import.meta.env.VITE_PROVIDER || 'groq');
  const [model, setModel] = useState(import.meta.env.VITE_MODEL || '');
  const [models, setModels] = useState({
    groq: import.meta.env.VITE_GROQ_MODEL || import.meta.env.VITE_MODEL || 'llama-3.3-70b-versatile',
    gemini: import.meta.env.VITE_GEMINI_MODEL || 'gemini-1.5-flash',
    openai: import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o-mini'
  });

  const [sessionState, setSessionState] = useState({ sessions: [], activeSessionId: null, messages: [] });
  const [keys, setKeys] = useState({ groq: [], gemini: [], openai: [] });
  const [fallbackEnabled, setFallbackEnabled] = useState(false);

  const bufferRef = useRef('');
  const loadingRef = useRef(false);
  const submitRef = useRef(() => {});
  const chatScrollRef = useRef(null);
  const textareaRef = useRef(null);

  // Group messages into question-answer pairs
  const historyPairs = useMemo(() => {
    const pairs = [];
    const msgs = sessionState.messages || [];
    let current = null;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'user') {
        current = {
          id: `pair_${i}`,
          question: m.content || '',
          timestamp: m.timestamp || Date.now(),
          answer: '',
          answerTimestamp: null
        };
        pairs.push(current);
      } else if (m.role === 'assistant' && current) {
        current.answer = m.content || '';
        current.answerTimestamp = m.timestamp || Date.now();
      }
    }
    return pairs;
  }, [sessionState.messages]);

  // Auto-scroll chat to bottom when messages change or while loading
  const scrollToBottom = useCallback((smooth = true) => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    }
  }, []);

  useEffect(() => {
    scrollToBottom(false);
  }, [historyPairs.length, loading, scrollToBottom]);

  // Auto-expand textarea height up to 4 lines, then show scrollbar
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 104; // ~4 lines
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${Math.max(34, nextHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  const setBuffer = useCallback((value) => {
    bufferRef.current = value;
    setInput(value);
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  const appendText = useCallback(
    (text) => {
      const next = (bufferRef.current + text).slice(0, MAX_PROMPT);
      setBuffer(next);
    },
    [setBuffer]
  );

  const backspace = useCallback(() => {
    setBuffer(bufferRef.current.slice(0, -1));
  }, [setBuffer]);

  const refreshSession = useCallback(async () => {
    try {
      if (window.assistant && window.assistant.sessionState) {
        const state = await window.assistant.sessionState();
        if (state && Array.isArray(state.messages)) {
          setSessionState(state);
        }
      }
    } catch {}
  }, []);

  const refreshKeys = useCallback(async () => {
    try {
      if (window.assistant && window.assistant.keysStatus) {
        const k = await window.assistant.keysStatus();
        if (k) setKeys(k);
      }
    } catch {}
  }, []);

  const submit = useCallback(async () => {
    const prompt = bufferRef.current.trim();
    if (!prompt || loadingRef.current) return;

    loadingRef.current = true;
    setLoading(true);
    setPendingPrompt(prompt);
    setError('');
    setBuffer('');

    // Reset textarea height to 1 line
    if (textareaRef.current) {
      textareaRef.current.style.height = '34px';
    }

    try {
      const result = await window.assistant.chat({ prompt, provider, model, fallback: fallbackEnabled });
      if (result && result.error) {
        setError(result.error);
      }
      await refreshSession();
    } catch (chatError) {
      setError(String(chatError && chatError.message ? chatError.message : chatError));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setPendingPrompt('');
      setTimeout(() => scrollToBottom(true), 60);
    }
  }, [setBuffer, provider, model, fallbackEnabled, refreshSession, scrollToBottom]);

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  // Hook for testing
  useEffect(() => {
    window.__assistantTestState = () => ({
      input: bufferRef.current,
      lastSent: historyPairs.length > 0 ? historyPairs[historyPairs.length - 1].question : '',
      response: historyPairs.length > 0 ? historyPairs[historyPairs.length - 1].answer : ''
    });
    return () => {
      delete window.__assistantTestState;
    };
  }, [historyPairs]);

  // Assistant overlay keyboard routing
  useEffect(() => {
    if (!window.assistant || !window.assistant.onKey) return;
    const removeKey = window.assistant.onKey((payload) => {
      if (!payload) return;
      if (payload.key === 'Backspace') {
        backspace();
        return;
      }
      if (payload.key === 'Enter') {
        submitRef.current();
        return;
      }
      if (typeof payload.text === 'string') {
        appendText(payload.text);
      }
    });
    return removeKey;
  }, [appendText, backspace]);

  // Status & polling
  useEffect(() => {
    let alive = true;
    if (window.assistant && window.assistant.getStatus) {
      window.assistant
        .getStatus()
        .then((next) => {
          if (alive && next) setStatus((current) => ({ ...current, ...next }));
        })
        .catch(() => {});
    }

    const removeStatus = window.assistant?.onStatus?.((next) => {
      setStatus((current) => ({ ...current, ...next }));
    });

    const removeForeground = window.assistant?.onForeground?.((foreground) => {
      setStatus((current) => ({ ...current, foreground }));
    });

    refreshSession();
    refreshKeys();

    return () => {
      alive = false;
      removeStatus?.();
      removeForeground?.();
    };
  }, [refreshSession, refreshKeys]);

  // Copy to clipboard helper
  const handleCopy = useCallback((id, text) => {
    if (!text) return;
    navigator.clipboard?.writeText?.(text);
    if (window.assistant?.setClipboard) {
      window.assistant.setClipboard(text);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  }, []);

  // Window expand toggle
  const handleToggleExpand = useCallback(async () => {
    const nextState = !isExpanded;
    setIsExpanded(nextState);
    if (window.assistant?.resizeWindow) {
      if (nextState) {
        await window.assistant.resizeWindow({ width: 740, height: 840 });
      } else {
        await window.assistant.resizeWindow({ width: 580, height: 660 });
      }
    }
  }, [isExpanded]);

  // Clear prompt
  const handleClearPrompt = useCallback(() => {
    setBuffer('');
    setError('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '34px';
    }
  }, [setBuffer]);

  // New session
  const handleNewSession = useCallback(async () => {
    try {
      if (window.assistant?.newSession) {
        const state = await window.assistant.newSession();
        if (state) setSessionState(state);
      }
      setBuffer('');
      setError('');
    } catch {}
  }, [setBuffer]);

  // Interactive corner drag resizing
  const handleResizeDragStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let initialBounds = null;

    window.assistant?.getBounds?.().then((b) => {
      initialBounds = b || { width: 580, height: 660 };
    });

    const onMouseMove = (moveEvent) => {
      if (!initialBounds) return;
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const newWidth = Math.max(380, initialBounds.width + deltaX);
      const newHeight = Math.max(260, initialBounds.height + deltaY);
      window.assistant?.resizeWindow?.({ width: newWidth, height: newHeight });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  // Textarea keyboard handling (Enter sends, Shift+Enter adds newline)
  const handleTextareaKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={`parakeet-app ${isExpanded ? 'is-expanded' : ''}`}>
      {/* 1. TOP PARAKEET HUD PILL BAR */}
      <div className="parakeet-top-pill drag-region">
        <div className="pill-left no-drag">
          <div className="status-indicator live" title="Screen share hidden protection">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span className="live-dot" />
          </div>

          <div className={`status-indicator ${status.routingActive ? 'active' : ''}`} title="Keyboard input routed">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            <span className="live-dot" />
          </div>
        </div>

        {/* Brand / Mode Pills */}
        <div className="pill-center no-drag">
          <div className="parakeet-mode-btn active">
            <span>Assistant</span>
            <kbd>⌘↵</kbd>
          </div>
          <button
            className="parakeet-mode-btn"
            onClick={handleNewSession}
            title="Start new conversation session"
            type="button"
          >
            <span>New Session</span>
          </button>
        </div>

        {/* Right utility buttons */}
        <div className="pill-right no-drag">
          <button
            className="parakeet-icon-btn drag-region"
            title="Drag window"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="5 9 2 12 5 15" />
              <polyline points="9 5 12 2 15 5" />
              <polyline points="15 19 12 22 9 19" />
              <polyline points="19 9 22 12 19 15" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
          </button>

          <button
            className="parakeet-icon-btn"
            onClick={handleToggleExpand}
            title={isExpanded ? 'Compact mode' : 'Expand window'}
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isExpanded ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              )}
            </svg>
          </button>

          <button
            className={`parakeet-icon-btn ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Settings & API Keys"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          <button
            className="parakeet-end-btn"
            onClick={() => window.assistant?.hide?.()}
            title="Hide assistant (Esc)"
            type="button"
          >
            End
          </button>
        </div>
      </div>

      {/* 2. MAIN PARAKEET CARD (CONTINUOUS SCROLLABLE CHAT DIALOG) */}
      <div className="parakeet-card">
        {/* Continuous scrollable conversation thread */}
        <div className="parakeet-chat-thread" ref={chatScrollRef}>
          {historyPairs.length === 0 && !loading ? (
            <div className="chat-welcome-box">
              <div className="welcome-lead">
                <span className="answer-icon">⭐</span>
                <strong>Welcome to Floating Assistant</strong>
                <p>Ask any question or interview query. All questions and answers will be saved in this conversation stream.</p>
              </div>
              <ul className="answer-bullets">
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Conversation History:</strong> All previous questions & answers stay in this dialog without needing to click previous/next.
                  </div>
                </li>
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Stretchable Input:</strong> Simple multi-line input box below that expands up to 4 lines with a clean scrollbar.
                  </div>
                </li>
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Scrollable:</strong> Scroll up and down comfortably over the full answer history.
                  </div>
                </li>
              </ul>
            </div>
          ) : null}

          {/* Render all question-answer pairs sequentially in same dialog */}
          {historyPairs.map((pair, idx) => {
            const parsed = parseAnswer(pair.answer);
            const isLatest = idx === historyPairs.length - 1;

            return (
              <div key={pair.id || idx} className="chat-turn-item">
                {/* QUESTION BLOCK */}
                <div className="turn-question-card">
                  <div className="question-header">
                    <div className="question-title">
                      <span className="question-icon">💭</span>
                      <strong>Question</strong>
                      <span className="message-time">{formatTime(pair.timestamp)}</span>
                    </div>
                    <button
                      className="copy-mini-btn"
                      onClick={() => handleCopy(`q_${idx}`, pair.question)}
                      title={copiedId === `q_${idx}` ? 'Copied!' : 'Copy question'}
                      type="button"
                    >
                      {copiedId === `q_${idx}` ? (
                        <span className="copied-text">Copied!</span>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <div className="question-body-text">{pair.question}</div>
                </div>

                {/* ANSWER BLOCK */}
                {pair.answer ? (
                  <div className="turn-answer-card">
                    <div className="answer-header">
                      <div className="answer-title">
                        <span className="answer-icon">⭐</span>
                        <strong>Answer</strong>
                        <span className="message-time">{formatTime(pair.answerTimestamp)}</span>
                      </div>
                      <button
                        className="copy-mini-btn"
                        onClick={() => handleCopy(`a_${idx}`, pair.answer)}
                        title={copiedId === `a_${idx}` ? 'Copied!' : 'Copy answer'}
                        type="button"
                      >
                        {copiedId === `a_${idx}` ? (
                          <span className="copied-text">Copied!</span>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    </div>

                    <div className="answer-body-content">
                      {/* Lead Summary */}
                      {parsed.summary && (
                        <div className="answer-lead-line">
                          <strong>Summary: </strong>
                          <span>{parsed.summary}</span>
                        </div>
                      )}

                      {/* Bullet points */}
                      {parsed.points && parsed.points.length > 0 && (
                        <ul className="answer-bullets">
                          {parsed.points.map((pt, pIdx) => (
                            <li key={pIdx} className="bullet-item">
                              <span className="bullet-dot">•</span>
                              <div className="bullet-text">
                                {pt.label && <strong>{pt.label}: </strong>}
                                <span>{pt.content}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* Additional notes/callouts */}
                      {parsed.notes && parsed.notes.length > 0 && (
                        <div className="answer-callouts">
                          {parsed.notes.map((note, nIdx) => (
                            <div key={nIdx} className="callout-box">
                              {note}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Turn Footer with Thumbs Feedback */}
                    <div className="turn-footer-row">
                      <div className="feedback-group">
                        <button
                          className={`feedback-btn ${thumbsFeedback[pair.id || idx] === 'up' ? 'active' : ''}`}
                          onClick={() => setThumbsFeedback((p) => ({ ...p, [pair.id || idx]: p[pair.id || idx] === 'up' ? null : 'up' }))}
                          title="Helpful"
                          type="button"
                        >
                          👍
                        </button>
                        <button
                          className={`feedback-btn ${thumbsFeedback[pair.id || idx] === 'down' ? 'active' : ''}`}
                          onClick={() => setThumbsFeedback((p) => ({ ...p, [pair.id || idx]: p[pair.id || idx] === 'down' ? null : 'down' }))}
                          title="Unhelpful"
                          type="button"
                        >
                          👎
                        </button>
                      </div>
                      <span className="turn-session-tag">turn {idx + 1}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Pending / Thinking state */}
          {loading && (
            <div className="chat-turn-item">
              <div className="turn-question-card">
                <div className="question-header">
                  <div className="question-title">
                    <span className="question-icon">💭</span>
                    <strong>Question</strong>
                    <span className="message-time">Just now</span>
                  </div>
                </div>
                <div className="question-body-text">{pendingPrompt}</div>
              </div>

              <div className="turn-answer-card thinking-card">
                <div className="loading-shimmer-title">
                  <span className="answer-icon">⭐</span>
                  <strong>Answer:</strong>
                  <span className="shimmer-text">Analyzing & formulating response…</span>
                </div>
                <div className="loading-shimmer-lines">
                  <div className="shimmer-line line-1" />
                  <div className="shimmer-line line-2" />
                  <div className="shimmer-line line-3" />
                </div>
              </div>
            </div>
          )}

          {/* Error Message */}
          {!loading && error && (
            <div className="answer-error-state">
              <div className="error-badge">
                <span className="error-icon">⚠️</span>
                <strong>Provider Error:</strong>
              </div>
              <p className="error-message">{error}</p>
            </div>
          )}
        </div>

        {/* HUD Card Footer / Info Bar */}
        <div className="card-footer-row">
          <div className="footer-meta">
            <span className="meta-text">
              {historyPairs.length} {historyPairs.length === 1 ? 'message' : 'messages'}
            </span>
          </div>

          <div className="footer-system-badges">
            <span className="system-pill" title="Provider & Model">
              {provider}: {model || models[provider]}
            </span>
            <span className={`system-pill ${status.captureProtected ? 'safe' : 'warn'}`}>
              {status.captureProtected ? 'hidden from share' : 'share visible'}
            </span>
          </div>
        </div>

        {/* Interactive Corner Resize Handle */}
        <div
          className="parakeet-resize-handle"
          onMouseDown={handleResizeDragStart}
          title="Drag to resize dialog"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M8 2L2 8M9 5L5 9M9 8L8 9" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* 3. SIMPLE AUTO-EXPANDING & STRETCHABLE INPUT TEXTAREA */}
      <div className="parakeet-input-container">
        {/* Equalizer Wave Indicator */}
        <div className={`parakeet-wave ${loading ? 'thinking' : status.routingActive ? 'listening' : ''}`} title="Input visualizer">
          <span className="wave-bar bar-1" />
          <span className="wave-bar bar-2" />
          <span className="wave-bar bar-3" />
          <span className="wave-bar bar-4" />
        </div>

        {/* Clean auto-expanding textarea (stretches, wraps text, max 4 lines, scrollbar) */}
        <div className="textarea-wrapper">
          <textarea
            ref={textareaRef}
            className="parakeet-textarea no-drag"
            placeholder={
              status.routingActive
                ? 'Type your question (Enter to send, Shift+Enter for new line)…'
                : 'Type here or press Ctrl+Shift+Space to route keyboard…'
            }
            value={input}
            onChange={(e) => setBuffer(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            rows={1}
            maxLength={MAX_PROMPT}
          />
        </div>

        {/* Action Buttons */}
        <div className="input-actions no-drag">
          {input ? (
            <button
              className="pill-clear-btn"
              onClick={handleClearPrompt}
              title="Clear input"
              type="button"
            >
              Clear
            </button>
          ) : null}

          <button
            className="pill-send-btn"
            disabled={!input.trim() || loading}
            onClick={submit}
            title="Send question (Enter)"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </div>

      {/* 4. SETTINGS MODAL / SLIDEOUT */}
      {showSettings && (
        <div className="parakeet-settings-modal">
          <div className="settings-content">
            <div className="settings-header">
              <h3>AI & Provider Settings</h3>
              <button className="close-btn" onClick={() => setShowSettings(false)} type="button">
                ✕
              </button>
            </div>

            <div className="settings-row">
              <label>Provider</label>
              <select
                className="settings-select"
                value={provider}
                onChange={(e) => {
                  const p = e.target.value;
                  setProvider(p);
                  setModel(models[p] || '');
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label>Model Name</label>
              <input
                className="settings-input"
                placeholder="Model name"
                value={model || models[provider] || ''}
                onChange={(e) => {
                  const m = e.target.value;
                  setModel(m);
                  setModels((prev) => ({ ...prev, [provider]: m }));
                }}
              />
            </div>

            <div className="settings-row checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={fallbackEnabled}
                  onChange={(e) => setFallbackEnabled(e.target.checked)}
                />
                <span>Allow auto-fallback to Groq if rate-limited</span>
              </label>
            </div>

            <div className="api-keys-section">
              <h4>API Keys ({provider})</h4>
              <div className="key-input-row">
                <input
                  id={`key-input-${provider}`}
                  className="settings-input"
                  placeholder={`Add new ${provider} key`}
                />
                <button
                  className="settings-btn primary"
                  type="button"
                  onClick={async () => {
                    const el = document.getElementById(`key-input-${provider}`);
                    const val = el?.value?.trim();
                    if (!val) return;
                    await window.assistant?.addKey?.({ provider, key: val });
                    if (el) el.value = '';
                    await refreshKeys();
                  }}
                >
                  Add
                </button>
                <button
                  className="settings-btn"
                  type="button"
                  onClick={async () => {
                    await window.assistant?.testKey?.({ provider });
                    await refreshKeys();
                  }}
                >
                  Test
                </button>
              </div>

              <div className="keys-badges">
                {(keys[provider] || []).map((k, idx) => (
                  <span key={k.id || idx} className="key-pill">
                    {k.masked || '••••••••'} {k.invalid ? '(invalid)' : k.cooldownUntil && k.cooldownUntil > Date.now() ? '(cooldown)' : '(active)'}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
