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

export default function App() {
  const [input, setInput] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastSent, setLastSent] = useState('');
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [copiedText, setCopiedText] = useState('');
  const [hasCopied, setHasCopied] = useState(false);

  const bufferRef = useRef('');
  const loadingRef = useRef(false);
  const lastSentRef = useRef('');
  const responseRef = useRef('');
  const submitRef = useRef(() => {});

  const setBuffer = useCallback((value) => {
    bufferRef.current = value;
    setInput(value);
  }, []);

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

  const submit = useCallback(async () => {
    const prompt = bufferRef.current.trim();
    if (!prompt || loadingRef.current) return;

    loadingRef.current = true;
    lastSentRef.current = prompt;
    responseRef.current = '';
    setLastSent(prompt);
    setLoading(true);
    setError('');
    setResponse('');
    setBuffer('');

    try {
      const result = await window.assistant.chat(prompt);
      if (result && result.error) {
        setError(result.error);
      } else {
        const text = result && result.text ? result.text : '';
        responseRef.current = text;
        setResponse(text);
      }
    } catch (chatError) {
      setError(String(chatError && chatError.message ? chatError.message : chatError));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [setBuffer]);

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  useEffect(() => {
    window.__assistantTestState = () => ({
      input: bufferRef.current,
      lastSent: lastSentRef.current,
      response: responseRef.current
    });

    return () => {
      delete window.__assistantTestState;
    };
  }, []);

  useEffect(() => {
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

  useEffect(() => {
    let alive = true;

    window.assistant
      .getStatus()
      .then((next) => {
        if (alive) setStatus((current) => ({ ...current, ...next }));
      })
      .catch(() => {});

    const removeStatus = window.assistant.onStatus((next) => {
      setStatus((current) => ({ ...current, ...next }));
    });

    const removeForeground = window.assistant.onForeground((foreground) => {
      setStatus((current) => ({ ...current, foreground }));
    });

    const checkClipboard = async () => {
      try {
        const text = await window.assistant.getClipboard();
        if (typeof text === 'string' && text.trim().length > 0) {
          setCopiedText(text);
          setHasCopied(true);
        } else {
          setHasCopied(false);
        }
      } catch {
        setHasCopied(false);
      }
    };

    checkClipboard();
    const interval = setInterval(checkClipboard, 1000);

    return () => {
      alive = false;
      removeStatus();
      removeForeground();
      clearInterval(interval);
    };
  }, []);

  const foregroundLabel = useMemo(() => {
    if (!status.foreground) return 'detecting...';
    const process = status.foreground.process || 'unknown';
    const title = status.foreground.title || '';
    return title ? `${process} — ${title}` : process;
  }, [status.foreground]);

  const chromeForeground = useMemo(() => {
    const process = status.foreground && status.foreground.process;
    return typeof process === 'string' && process.toLowerCase().includes('chrome');
  }, [status.foreground]);

  const canSend = input.trim().length > 0 && !loading;

  const handlePasteCopied = useCallback(() => {
    if (!copiedText) return;
    const next = (bufferRef.current + copiedText).slice(0, MAX_PROMPT);
    setBuffer(next);
    setHasCopied(false);
  }, [copiedText, setBuffer]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className={`status-dot ${status.routingActive ? 'on' : 'off'}`} />
          <div>
            <h1>Floating Assistant</h1>
            <p>Ctrl + Shift + Space to show / hide · hidden from screen share</p>
          </div>
        </div>
        <button
          className="icon-button no-drag"
          type="button"
          title="Hide (Esc)"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => window.assistant.hide()}
        >
          ✕
        </button>
      </header>

      <section className="focus-strip">
        <div>
          <span className="label">Foreground</span>
          <strong className={chromeForeground ? 'good' : ''}>{foregroundLabel}</strong>
        </div>
        <div className="focus-flags">
          <span className={`pill ${status.routingActive ? 'good' : 'warn'}`}>
            routing {status.routingActive ? 'ON' : 'OFF'}
          </span>
          <span className={`pill ${status.overlayFocused ? 'warn' : 'good'}`}>
            overlay focus {status.overlayFocused ? 'YES' : 'NO'}
          </span>
          <span className={`pill ${status.captureProtected ? 'good' : 'warn'}`}>
            {status.captureProtected ? 'hidden from share' : 'visible in share'}
          </span>
        </div>
      </section>

      <section className="prompt-section">
        <div className="prompt-label">
          <span>Prompt</span>
          <span className="muted">keyboard is routed here, not to the page</span>
        </div>
        <div className="prompt-display" aria-label="Prompt input">
          {input ? (
            <span>{input}</span>
          ) : (
            <span className="placeholder">Type here while Chrome stays foreground…</span>
          )}
          <span className={`caret ${status.routingActive ? 'blink' : ''}`} />
        </div>
        <div className="prompt-actions">
          <span className="muted">
            {input.length}/{MAX_PROMPT}
          </span>
          <div className="buttons">
            {hasCopied && copiedText ? (
              <button
                className="secondary no-drag"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handlePasteCopied}
                title={copiedText.slice(0, 100)}
              >
                Paste copied
              </button>
            ) : null}
            <button
              className="secondary no-drag"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setBuffer('');
                setError('');
              }}
            >
              Clear
            </button>
            <button
              className="primary no-drag"
              type="button"
              disabled={!canSend}
              onMouseDown={(event) => event.preventDefault()}
              onClick={submit}
            >
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </section>

      <section className="response-section">
        <div className="prompt-label">
          <span>Response</span>
          {lastSent ? <span className="muted">last prompt: {lastSent}</span> : null}
        </div>
        <div className="response-box">
          {loading ? <span className="muted">Thinking…</span> : null}
          {!loading && error ? <span className="error">{error}</span> : null}
          {!loading && !error && response ? <span>{response}</span> : null}
          {!loading && !error && !response ? (
            <span className="placeholder">The answer will appear here.</span>
          ) : null}
        </div>
      </section>

      <footer className="footer">
        <span>Esc closes · Enter sends</span>
        <span className={`pill ${status.routingActive ? 'good' : 'warn'}`}>
          {status.routingFailures && status.routingFailures.length > 0
            ? `routing partial (${status.routingFailures.length})`
            : status.routingActive
              ? 'input routed'
              : 'routing off'}
        </span>
      </footer>
    </div>
  );
}
