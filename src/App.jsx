import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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

// Format inline markdown (inline code, bold, italic)
function formatInlineText(text) {
  if (!text) return null;
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const parts = [];
  let lastIdx = 0;
  let match;
  let k = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={k++} className="inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={k++} className="inline-bold">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={k++}>{token.slice(1, -1)}</em>);
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return parts;
}

// Parse text chunks into structured headings, tables, blockquotes, lists, and paragraphs
function parseTextBlocks(chunk, prefix) {
  const blocks = [];
  const lines = chunk.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let subId = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Table: consecutive lines starting with '|' and ending with '|'
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        blocks.push({
          type: 'table',
          id: `${prefix}_tbl_${subId++}`,
          lines: tableLines
        });
        continue;
      }
    }

    // 2. Blockquote: consecutive lines starting with '>'
    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        id: `${prefix}_bq_${subId++}`,
        content: quoteLines.join('\n')
      });
      continue;
    }

    // 3. Headings: '#', '##', '###'
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        id: `${prefix}_h_${subId++}`,
        level: headingMatch[1].length,
        text: headingMatch[2]
      });
      i++;
      continue;
    }

    // 4. List items: '1. ', '2. ', '- ', '* ', '• '
    const listMatch = trimmed.match(/^(\d+\.|[•\-*])\s+(.+)$/);
    if (listMatch) {
      blocks.push({
        type: 'list_item',
        id: `${prefix}_li_${subId++}`,
        bullet: listMatch[1],
        content: listMatch[2]
      });
      i++;
      continue;
    }

    // 5. Paragraph text: accumulate regular lines
    const pLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('|') &&
      !lines[i].trim().startsWith('>') &&
      !lines[i].trim().match(/^#{1,4}\s+/) &&
      !lines[i].trim().match(/^(\d+\.|[•\-*])\s+/)
    ) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      id: `${prefix}_p_${subId++}`,
      content: pLines.join(' ')
    });
  }

  return blocks;
}

// Split full response into code blocks and text blocks
function parseMarkdown(raw) {
  if (!raw) return [];
  const blocks = [];
  const codeRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  let blockId = 0;

  while ((match = codeRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const textChunk = raw.slice(lastIndex, match.index);
      if (textChunk.trim()) {
        blocks.push(...parseTextBlocks(textChunk, `b_${blockId++}`));
      }
    }
    blocks.push({
      type: 'code',
      id: `code_${blockId++}`,
      language: (match[1] || 'code').trim(),
      code: match[2].replace(/\r\n/g, '\n').replace(/\n$/, '')
    });
    lastIndex = codeRegex.lastIndex;
  }

  if (lastIndex < raw.length) {
    const trailing = raw.slice(lastIndex);
    if (trailing.trim()) {
      blocks.push(...parseTextBlocks(trailing, `b_${blockId++}`));
    }
  }

  return blocks;
}

// Code Block Component with 1-click Copy and exact indentation preservation
function CodeBlock({ id, language, code, onCopy, isCopied }) {
  return (
    <div className="formatted-code-container">
      <div className="code-header">
        <span className="code-lang-tag">{language || 'code'}</span>
        <button
          className="code-copy-btn"
          onClick={() => onCopy(id, code)}
          type="button"
          title="Copy code to clipboard"
        >
          {isCopied ? (
            <span className="copied-label">Copied!</span>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>Copy code</span>
            </>
          )}
        </button>
      </div>
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Table Component
function TableBlock({ lines }) {
  const rows = lines.map((l) =>
    l.split('|').slice(1, -1).map((c) => c.trim())
  );
  if (rows.length === 0) return null;
  const header = rows[0];
  const isSep = rows.length > 1 && rows[1].every((c) => /^[-:\s]+$/.test(c));
  const data = isSep ? rows.slice(2) : rows.slice(1);

  return (
    <div className="table-wrapper">
      <table className="formatted-table">
        <thead>
          <tr>
            {header.map((col, idx) => (
              <th key={idx}>{formatInlineText(col)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx}>{formatInlineText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Full Markdown Answer Renderer Component
function FormattedAnswer({ text, onCopy, copiedId }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  if (!blocks || blocks.length === 0) {
    return <div className="formatted-paragraph">{text}</div>;
  }

  return (
    <div className="formatted-answer-body">
      {blocks.map((block) => {
        switch (block.type) {
          case 'code':
            return (
              <CodeBlock
                key={block.id}
                id={block.id}
                language={block.language}
                code={block.code}
                onCopy={onCopy}
                isCopied={copiedId === block.id}
              />
            );
          case 'table':
            return <TableBlock key={block.id} lines={block.lines} />;
          case 'blockquote':
            return (
              <blockquote key={block.id} className="formatted-blockquote">
                {formatInlineText(block.content)}
              </blockquote>
            );
          case 'heading': {
            const HeadingTag = block.level <= 2 ? 'h3' : 'h4';
            return (
              <HeadingTag key={block.id} className="formatted-heading">
                {formatInlineText(block.text)}
              </HeadingTag>
            );
          }
          case 'list_item':
            return (
              <div key={block.id} className="formatted-list-item">
                <span className="list-bullet">{block.bullet}</span>
                <div className="list-content">{formatInlineText(block.content)}</div>
              </div>
            );
          case 'paragraph':
          default:
            return (
              <p key={block.id} className="formatted-paragraph">
                {formatInlineText(block.content)}
              </p>
            );
        }
      })}
    </div>
  );
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
  const [selectedTextBanner, setSelectedTextBanner] = useState('');

  const [provider, setProvider] = useState(import.meta.env.VITE_PROVIDER || 'groq');
  const [model, setModel] = useState(import.meta.env.VITE_MODEL || '');
  const [models, setModels] = useState({
    groq: import.meta.env.VITE_GROQ_MODEL || import.meta.env.VITE_MODEL || 'openai/gpt-oss-120b',
    gemini: import.meta.env.VITE_GEMINI_MODEL || 'gemini-3.8-flash',
    openai: import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o-mini'
  });

  const [sessionState, setSessionState] = useState({ sessions: [], activeSessionId: null, messages: [] });
  const [keys, setKeys] = useState({ groq: [], gemini: [], openai: [] });
  const [fallbackEnabled, setFallbackEnabled] = useState(false);

  const bufferRef = useRef('');
  const loadingRef = useRef(false);
  const submitRef = useRef(() => { });
  const chatScrollRef = useRef(null);
  const textareaRef = useRef(null);
  const lastProcessedClipRef = useRef('');
  const cursorPosRef = useRef(0);

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

  // Auto-scroll chat to bottom
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
    const el = textareaRef.current;
    if (el) {
      cursorPosRef.current = el.selectionStart ?? value.length;
    } else {
      cursorPosRef.current = value.length;
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Maintain precise cursor position across React state updates
  useLayoutEffect(() => {
    if (textareaRef.current) {
      const pos = Math.min(cursorPosRef.current, input.length);
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, [input]);

  // Cursor-aware insertion & backspace for background routed keys
  const insertTextAtCursor = useCallback((text) => {
    const el = textareaRef.current;
    const current = bufferRef.current;
    const start = el ? el.selectionStart : cursorPosRef.current;
    const end = el ? el.selectionEnd : cursorPosRef.current;
    const next = (current.slice(0, start) + text + current.slice(end)).slice(0, MAX_PROMPT);
    const nextPos = Math.min(start + text.length, MAX_PROMPT);
    cursorPosRef.current = nextPos;
    bufferRef.current = next;
    setInput(next);
  }, []);

  const backspaceAtCursor = useCallback(() => {
    const el = textareaRef.current;
    const current = bufferRef.current;
    const start = el ? el.selectionStart : cursorPosRef.current;
    const end = el ? el.selectionEnd : cursorPosRef.current;
    if (start !== end) {
      const next = current.slice(0, start) + current.slice(end);
      cursorPosRef.current = start;
      bufferRef.current = next;
      setInput(next);
    } else if (start > 0) {
      const next = current.slice(0, start - 1) + current.slice(start);
      cursorPosRef.current = start - 1;
      bufferRef.current = next;
      setInput(next);
    }
  }, []);

  const moveCursorLeft = useCallback(() => {
    const el = textareaRef.current;
    const start = el ? el.selectionStart : cursorPosRef.current;
    const nextPos = Math.max(0, start - 1);
    cursorPosRef.current = nextPos;
    if (el) el.setSelectionRange(nextPos, nextPos);
  }, []);

  const moveCursorRight = useCallback(() => {
    const el = textareaRef.current;
    const end = el ? el.selectionEnd : cursorPosRef.current;
    const nextPos = Math.min(bufferRef.current.length, end + 1);
    cursorPosRef.current = nextPos;
    if (el) el.setSelectionRange(nextPos, nextPos);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      if (window.assistant && window.assistant.sessionState) {
        const state = await window.assistant.sessionState();
        if (state && Array.isArray(state.messages)) {
          setSessionState(state);
        }
      }
    } catch { }
  }, []);

  const refreshKeys = useCallback(async () => {
    try {
      if (window.assistant && window.assistant.keysStatus) {
        const k = await window.assistant.keysStatus();
        if (k) setKeys(k);
      }
    } catch { }
  }, []);

  const submit = useCallback(async () => {
    const prompt = bufferRef.current.trim();
    if (!prompt || loadingRef.current) return;

    loadingRef.current = true;
    setLoading(true);
    setPendingPrompt(prompt);
    setError('');
    setBuffer('');

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

  // Overlay keyboard listener (receives routed keys without stealing focus from background app)
  useEffect(() => {
    if (!window.assistant || !window.assistant.onKey) return;
    const removeKey = window.assistant.onKey((payload) => {
      if (!payload) return;
      if (payload.key === 'Backspace') {
        backspaceAtCursor();
        return;
      }
      if (payload.key === 'Enter') {
        submitRef.current();
        return;
      }
      if (payload.key === 'ArrowLeft') {
        moveCursorLeft();
        return;
      }
      if (payload.key === 'ArrowRight') {
        moveCursorRight();
        return;
      }
      if (typeof payload.text === 'string') {
        insertTextAtCursor(payload.text);
      }
    });
    return removeKey;
  }, [insertTextAtCursor, backspaceAtCursor, moveCursorLeft, moveCursorRight]);

  // Status & polling
  useEffect(() => {
    let alive = true;
    if (window.assistant && window.assistant.getStatus) {
      window.assistant
        .getStatus()
        .then((next) => {
          if (alive && next) setStatus((current) => ({ ...current, ...next }));
        })
        .catch(() => { });
    }

    const removeStatus = window.assistant?.onStatus?.((next) => {
      setStatus((current) => ({ ...current, ...next }));
    });

    const removeForeground = window.assistant?.onForeground?.((foreground) => {
      setStatus((current) => ({ ...current, foreground }));
    });

    const removeClipboard = window.assistant?.onClipboardChanged?.((newText) => {
      if (typeof newText === 'string' && newText.trim().length > 0 && newText.trim() !== bufferRef.current.trim() && newText.trim() !== lastProcessedClipRef.current) {
        lastProcessedClipRef.current = newText.trim();
        setSelectedTextBanner(newText.trim());
      }
    });

    // Check clipboard periodically when selecting text in browser tab
    const checkClipboard = async () => {
      try {
        const text = await window.assistant?.getClipboard?.();
        if (
          typeof text === 'string' &&
          text.trim().length > 0 &&
          text.trim() !== bufferRef.current.trim() &&
          text.trim() !== lastProcessedClipRef.current
        ) {
          lastProcessedClipRef.current = text.trim();
          setSelectedTextBanner(text.trim());
        }
      } catch { }
    };

    const clipInterval = setInterval(checkClipboard, 600);

    refreshSession();
    refreshKeys();

    return () => {
      alive = false;
      removeStatus?.();
      removeForeground?.();
      removeClipboard?.();
      clearInterval(clipInterval);
    };
  }, [refreshSession, refreshKeys]);

  // Paste selected text from browser into input at cursor position
  const handlePasteSelected = useCallback(
    (textToPaste) => {
      const text = typeof textToPaste === 'string' ? textToPaste : selectedTextBanner;
      if (!text) return;
      const el = textareaRef.current;
      const current = bufferRef.current;
      const start = el ? el.selectionStart : cursorPosRef.current;
      const end = el ? el.selectionEnd : cursorPosRef.current;
      const next = (current.slice(0, start) + text + current.slice(end)).slice(0, MAX_PROMPT);
      const nextPos = Math.min(start + text.length, MAX_PROMPT);
      cursorPosRef.current = nextPos;
      bufferRef.current = next;
      setInput(next);
      setSelectedTextBanner('');
    },
    [selectedTextBanner]
  );

  // Copy helper
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
        await window.assistant.resizeWindow({ width: 760, height: 860 });
      } else {
        await window.assistant.resizeWindow({ width: 580, height: 660 });
      }
    }
  }, [isExpanded]);

  // Clear prompt
  const handleClearPrompt = useCallback(() => {
    cursorPosRef.current = 0;
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
    } catch { }
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

  // Textarea Enter key handling
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
                <p>Ask any programming question, interview problem, or query. All answers will be formatted cleanly with proper code blocks and indentation.</p>
              </div>
              <ul className="answer-bullets">
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Code Blocks:</strong> Formatted with monospace font, exact indentation, language labels, and a 1-click Copy button.
                  </div>
                </li>
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Continuous History:</strong> All questions and answers stay together in one scrollable thread.
                  </div>
                </li>
                <li className="bullet-item">
                  <span className="bullet-dot">•</span>
                  <div className="bullet-text">
                    <strong>Stretchable Input:</strong> Simple multi-line input box below that expands up to 4 lines with a clean scrollbar.
                  </div>
                </li>
              </ul>
            </div>
          ) : null}

          {/* Render all question-answer pairs sequentially in same dialog */}
          {historyPairs.map((pair, idx) => {
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

                {/* ANSWER BLOCK WITH MARKDOWN & CODE BLOCKS */}
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
                        title={copiedId === `a_${idx}` ? 'Copied!' : 'Copy full answer'}
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

                    {/* Properly formatted markdown content (headings, code blocks, tables, lists, quotes) */}
                    <FormattedAnswer
                      text={pair.answer}
                      onCopy={handleCopy}
                      copiedId={copiedId}
                    />

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

      {/* FLOATING BROWSER SELECTION PASTE BANNER */}
      {selectedTextBanner ? (
        <div className="parakeet-paste-banner">
          <div className="paste-banner-info">
            <span className="paste-banner-icon">📋</span>
            <span className="paste-banner-title">Selected in browser:</span>
            <span className="paste-banner-snippet">
              "{selectedTextBanner.slice(0, 65).replace(/\s+/g, ' ')}{selectedTextBanner.length > 65 ? '…' : ''}"
            </span>
          </div>
          <div className="paste-banner-actions">
            <button
              className="paste-confirm-btn no-drag"
              onClick={() => handlePasteSelected(selectedTextBanner)}
              type="button"
            >
              Paste
            </button>
            <button
              className="paste-dismiss-btn no-drag"
              onClick={() => setSelectedTextBanner('')}
              title="Dismiss"
              type="button"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {/* 3. SIMPLE AUTO-EXPANDING & STRETCHABLE INPUT TEXTAREA */}
      <div className="parakeet-input-container no-drag">
        {/* Equalizer Wave Indicator */}
        <div className={`parakeet-wave ${loading ? 'thinking' : status.routingActive ? 'listening' : ''}`} title="Input visualizer">
          <span className="wave-bar bar-1" />
          <span className="wave-bar bar-2" />
          <span className="wave-bar bar-3" />
          <span className="wave-bar bar-4" />
        </div>

        {/* Clean auto-expanding textarea */}
        <div className="textarea-wrapper no-drag">
          <textarea
            ref={textareaRef}
            className="parakeet-textarea no-drag"
            placeholder={
              status.routingActive
                ? 'Type your question (Enter to send, Shift+Enter for new line)…'
                : 'Type your question or paste prompt here…'
            }
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              cursorPosRef.current = e.target.selectionStart;
              bufferRef.current = val;
              setInput(val);
            }}
            onSelect={(e) => {
              cursorPosRef.current = e.target.selectionStart;
            }}
            onClick={(e) => {
              cursorPosRef.current = e.target.selectionStart;
            }}
            onKeyUp={(e) => {
              cursorPosRef.current = e.target.selectionStart;
            }}
            onKeyDown={handleTextareaKeyDown}
            rows={1}
            maxLength={MAX_PROMPT}
          />
        </div>

        {/* Action Buttons */}
        <div className="input-actions no-drag">
          <button
            className="pill-paste-btn"
            onClick={async () => {
              try {
                let text = await window.assistant?.copyForegroundSelection?.();
                if (!text || !text.trim()) {
                  text = await window.assistant?.getClipboard?.();
                }
                if (text && text.trim()) {
                  handlePasteSelected(text.trim());
                }
              } catch {
                try {
                  const clip = await window.assistant?.getClipboard?.();
                  if (clip && clip.trim()) {
                    handlePasteSelected(clip.trim());
                  }
                } catch { }
              }
            }}
            title="Paste selected text from browser / clipboard (no Ctrl+C needed)"
            type="button"
          >
            Paste
          </button>

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
