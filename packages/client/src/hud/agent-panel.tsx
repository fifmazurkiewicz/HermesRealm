import { useState } from 'react';
import type { HeroSnapshot, HeroStateKind } from '@agent-citadel/shared';
import { useWorld } from '../store';
import { useSettings } from '../settings';
import { teamColorHex } from '../game/placeholders';
import { assignTask } from '../sessions';
import { clip, formatK } from '../util';
import { ProviderEmblem } from './ProviderEmblem';

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

/**
 * Estimation bar: visual progress bar for time-based task completion.
 * Data comes from historical stats stored on the server.
 */
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

/**
 * Agent panel: right-side HUD for Hermes agents with task assignment.
 * Shown when a Hermes agent is selected — extends the existing SidePanel concept
 * but focused on Hermes-specific interactions.
 */
export function AgentPanel() {
  const selected = useWorld((s) => s.selectedSessionId);
  const hero = useWorld((s) => (selected ? s.heroes[selected] : undefined));
  const select = useWorld((s) => s.select);
  const [taskText, setTaskText] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // Only show for Hermes agents
  if (!selected || !hero || hero.agent !== 'hermes') return null;

  const st = STATE_STYLE[hero.state];
  const job = hero.state === 'working' ? hero.toolDetail ?? hero.currentTool : undefined;

  const handleAssign = async () => {
    const prompt = taskText.trim();
    if (!prompt) return;
    setSending(true);
    setFeedback(null);
    try {
      const result = await assignTask(hero.title, prompt);
      if (result.ok) {
        setFeedback({ ok: true, msg: 'Task dispatched! Agent will appear as a new session.' });
        setTaskText('');
      } else {
        setFeedback({ ok: false, msg: result.error ?? 'Failed to assign task' });
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error' });
    } finally {
      setSending(false);
    }
  };

  // Estimation: for now a placeholder, will show real data when historical stats are available
  const estPct = 0; // placeholder
  const estLabel = estPct > 0 ? `⏱️ ~45 min ████████░░░░ ${estPct}%` : '⏱️ No estimate yet';

  return (
    <div className="hud-panel" style={{
      position: 'absolute',
      top: 12,
      right: 364, // Offset from the main sidepanel
      width: 300,
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
          </div>
        </div>
        <button className="ghost" onClick={() => select(undefined)}>✕</button>
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
          <b style={{ color: st.color }}>{st.color === '#5dcaa5' ? 'working' : hero.state}</b>
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

      {/* Estimation bar */}
      <div style={{ padding: '6px 0' }}>
        <EstimationBar pct={estPct} label={estLabel} />
      </div>

      {/* Assign task */}
      <div style={{ borderTop: '1px solid #33332f', paddingTop: 8 }}>
        <div className="px" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.55, marginBottom: 6 }}>
          Assign task
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAssign(); }}
            placeholder="What should the agent do?"
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
            onClick={() => void handleAssign()}
            disabled={sending || !taskText.trim()}
            style={{ whiteSpace: 'nowrap' }}
          >
            {sending ? '...' : 'Send'}
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
          Spawns a new Hermes CLI session with your prompt
        </div>
      </div>
    </div>
  );
}