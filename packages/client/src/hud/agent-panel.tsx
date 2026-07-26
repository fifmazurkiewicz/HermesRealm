import { useState, useRef, useEffect } from 'react';
import type { HeroSnapshot, HeroStateKind } from '@agent-citadel/shared';
import { useWorld } from '../store';
import { useSettings } from '../settings';
import { teamColorHex } from '../game/placeholders';
import { assignTask, chatWithHermes } from '../sessions';
import { clip, formatK } from '../util';
import { ProviderEmblem } from './ProviderEmblem';

interface ChatMessage {
  role: 'user' | 'hermes';
  text: string;
  ts: string;
}

/** Color + emoji per state. */
const STATE_STYLE: Record<HeroStateKind, { color: string; emoji: string }> = {
  working: { color: '#5dcaa5', emoji: '⚙️' },
  thinking: { color: '#85b7eb', emoji: '💭' },
  'awaiting-input': { color: '#ef9f27', emoji: '✋' },
  error: { color: '#f09595', emoji: '⚠️' },
  recovering: { color: '#e48aa2', emoji: '⚕️' },
  idle: { color: '#b4b2a9', emoji: '⏸️' },
  sleeping: { color: '#888780', emoji: '💤' },
  returning: { color: '#97c459', emoji: '🚶' },
};

function EstimationBar({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ marginTop: 6 }}>
      <div className="px" style={{ fontSize: 11, opacity: 0.7, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ background: '#15140f', height: 8, borderRadius: 0 }}>
        <div
          style={{
            width: `${clamped}%`,
            height: '100%',
            background: clamped < 40 ? '#e24b4a' : clamped < 75 ? '#f0d76e' : '#5dcaa5',
            transition: 'width 0.6s ease',
          }}
        />
      </div>
    </div>
  );
}

export function AgentPanel() {
  const selected = useWorld((s) => s.selectedSessionId);
  const hero = useWorld((s) => (selected ? s.heroes[selected] : undefined));
  const select = useWorld((s) => s.select);
  const [taskText, setTaskText] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Only show for Hermes agents
  if (!selected || !hero || hero.agent !== 'hermes') return null;

  const st = STATE_STYLE[hero.state];
  const job = hero.state === 'working' ? hero.toolDetail ?? hero.currentTool : undefined;

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  const handleSend = async () => {
    const text = taskText.trim();
    if (!text) return;
    setSending(true);
    setFeedback(null);

    // Add user message to history immediately
    const userMsg: ChatMessage = { role: 'user', text, ts: new Date().toISOString() };
    setChatHistory((prev) => [...prev, userMsg]);
    setTaskText('');

    try {
      const result = await chatWithHermes(text, chatSessionId);
      if (result.ok) {
        if (result.session_id) setChatSessionId(result.session_id);
        const hermesMsg: ChatMessage = {
          role: 'hermes',
          text: result.response ?? '(pusta odpowiedź)',
          ts: new Date().toISOString(),
        };
        setChatHistory((prev) => [...prev, hermesMsg]);
      } else {
        const errMsg: ChatMessage = {
          role: 'hermes',
          text: `❌ ${result.error ?? 'Błąd'}` + (result.response ? `\n${result.response.slice(0, 200)}` : ''),
          ts: new Date().toISOString(),
        };
        setChatHistory((prev) => [...prev, errMsg]);
        setFeedback({ ok: false, msg: result.error ?? 'Błąd komunikacji' });
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error' });
    } finally {
      setSending(false);
    }
  };

  const handleAssignFireAndForget = async () => {
    const prompt = taskText.trim();
    if (!prompt) return;
    setSending(true);
    setFeedback(null);
    try {
      const result = await assignTask(hero.title, prompt);
      if (result.ok) {
        setFeedback({ ok: true, msg: 'Task wysłany! Agent pojawi się jako nowa sesja.' });
        setTaskText('');
      } else {
        setFeedback({ ok: false, msg: result.error ?? 'Błąd' });
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error' });
    } finally {
      setSending(false);
    }
  };

  const estPct = 0;
  const estLabel = estPct > 0 ? `⏱️ ~45 min ████████░░░░ ${estPct}%` : '⏱️ Brak estymacji';

  return (
    <div className="hud-panel" style={{
      position: 'absolute',
      top: 12,
      right: 364,
      width: 320,
      maxHeight: 'calc(100vh - 100px)',
      display: 'flex',
      flexDirection: 'column',
      padding: 12,
      gap: 8,
      zIndex: 10,
    }}>
      {/* Header */}
      <div className="head" style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'start',
        gap: 8,
        boxShadow: `inset 3px 0 0 ${teamColorHex(hero.teamColor)}`,
      }}>
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <span style={{
            width: 14, height: 14, borderRadius: '50%',
            background: teamColorHex(hero.teamColor),
            border: '1px solid rgba(0,0,0,.4)',
            marginTop: 3, flex: 'none',
          }} />
          <div style={{ minWidth: 0 }}>
            <strong className="px" style={{ fontSize: 14, color: '#fac775' }}>
              {clip(hero.title, 22)}
            </strong>
            <ProviderEmblem agent={hero.agent} variant="pill" />
            {chatSessionId && (
              <div style={{ fontSize: 10, opacity: 0.5, marginTop: 1 }}>
                sesja: {chatSessionId.slice(-12)}
              </div>
            )}
          </div>
        </div>
        <button className="ghost" onClick={() => { select(undefined); setChatHistory([]); setChatSessionId(undefined); }}>✕</button>
      </div>

      {/* State badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: `${st.color}29`,
        boxShadow: `inset 2px 0 0 ${st.color}`,
        padding: '6px 10px', fontSize: 12,
      }}>
        <span style={{ fontSize: 14 }}>{st.emoji}</span>
        <span>
          <b style={{ color: st.color }}>{hero.state}</b>
          {job ? <span style={{ opacity: 0.85 }}> · {clip(job, 36)}</span> : null}
        </span>
      </div>

      {/* Token stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <div className="stat-tile">
          <div className="px" style={{ fontSize: 10, opacity: 0.55, textTransform: 'uppercase' }}>Output</div>
          <div style={{ fontSize: 14 }}>{formatK(hero.tokens.output)}</div>
        </div>
        <div className="stat-tile">
          <div className="px" style={{ fontSize: 10, opacity: 0.55, textTransform: 'uppercase' }}>Input</div>
          <div style={{ fontSize: 14 }}>{formatK(hero.tokens.input)}</div>
        </div>
      </div>

      <EstimationBar pct={estPct} label={estLabel} />

      {/* Chat history */}
      {chatHistory.length > 0 && (
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          borderTop: '1px solid #33332f',
          borderBottom: '1px solid #33332f',
          padding: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          {chatHistory.map((msg, i) => (
            <div key={i} style={{
              padding: '6px 8px',
              background: msg.role === 'user' ? '#2a2926' : '#1f1e1a',
              borderLeft: `2px solid ${msg.role === 'user' ? '#fac775' : '#5dcaa5'}`,
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              <div style={{ fontSize: 10, opacity: 0.4, marginBottom: 2 }}>
                {msg.role === 'user' ? 'Ty' : 'Hermes'}
              </div>
              {msg.text}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      )}

      {/* Input area */}
      <div style={{ borderTop: '1px solid #33332f', paddingTop: 8 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <button
            className="ghost"
            onClick={handleAssignFireAndForget}
            disabled={sending || !taskText.trim()}
            style={{ fontSize: 10, opacity: 0.6, padding: '2px 6px' }}
            title="Fire-and-forget: wysyła task bez oczekiwania na odpowiedź"
          >
            ⚡ Fire
          </button>
          <button
            className="ghost"
            onClick={() => { setChatHistory([]); setChatSessionId(undefined); }}
            disabled={chatHistory.length === 0}
            style={{ fontSize: 10, opacity: 0.6, padding: '2px 6px' }}
            title="Wyczyść historię czatu"
          >
            ✕ Clear
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
            placeholder={chatSessionId ? 'Kontynuuj rozmowę...' : 'Napisz do Hermesa...'}
            disabled={sending}
            style={{
              flex: 1,
              background: '#2a2926',
              border: '1px solid #45443f',
              color: '#f1efe8',
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
          <button
            className="ghost"
            onClick={() => void handleSend()}
            disabled={sending || !taskText.trim()}
            style={{ whiteSpace: 'nowrap', color: '#5dcaa5' }}
          >
            {sending ? '...' : '▶'}
          </button>
        </div>
        {feedback && (
          <div style={{
            marginTop: 6, fontSize: 11,
            color: feedback.ok ? '#5dcaa5' : '#e24b4a',
          }}>
            {feedback.msg}
          </div>
        )}
        <div style={{ fontSize: 10, opacity: 0.45, marginTop: 4 }}>
          Enter — wyślij z odpowiedzią · ⚡ Fire — wyślij bez czekania · Shift+Enter — nowa linia
        </div>
      </div>
    </div>
  );
}