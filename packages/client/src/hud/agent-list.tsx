import { useState, useMemo } from 'react';
import type { HeroSnapshot, HeroStateKind } from '@agent-citadel/shared';
import { useWorld } from '../store';
import { useSettings } from '../settings';
import { teamColorHex } from '../game/placeholders';
import { getGameView } from '../game/view';
import { clip } from '../util';
import { contextPct } from '../context-progress';

/** State badge style — compact emoji+color indicator. */
const STATE_BADGE: Record<HeroStateKind, { emoji: string; color: string }> = {
  working: { emoji: '⚙️', color: '#5dcaa5' },
  thinking: { emoji: '💭', color: '#85b7eb' },
  'awaiting-input': { emoji: '✋', color: '#ef9f27' },
  error: { emoji: '⚠️', color: '#f09595' },
  recovering: { emoji: '⚕️', color: '#e48aa2' },
  idle: { emoji: '⏸️', color: '#b4b2a9' },
  sleeping: { emoji: '💤', color: '#888780' },
  returning: { emoji: '🚶', color: '#97c459' },
};

/**
 * Agent list panel: collapsible sidebar (top-left) listing all agents.
 * Each row shows name + state badge + mini progress bar.
 * Click row → camera pans to that hero.
 */
export function AgentListPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const heroes = useWorld((s) => s.heroes);
  const selected = useWorld((s) => s.selectedSessionId);
  const select = useWorld((s) => s.select);
  const openQuestionId = useWorld((s) => s.openQuestionId);

  const items = useMemo(
    () =>
      Object.values(heroes)
        .filter((h) => h.state !== 'sleeping') // only active agents
        .sort((a, b) => {
          // Sort: active first (working > thinking > idle/other), then by recency
          const order: Record<string, number> = { working: 0, thinking: 1, 'awaiting-input': 2, error: 3, recovering: 4, returning: 5, idle: 6 };
          const oa = order[a.state] ?? 10;
          const ob = order[b.state] ?? 10;
          if (oa !== ob) return oa - ob;
          return b.lastActivityAt.localeCompare(a.lastActivityAt);
        }),
    [heroes],
  );

  if (items.length === 0) return null;

  return (
    <div className="hud-panel" style={{
      position: 'absolute',
      top: 48,
      left: 12,
      width: collapsed ? 36 : 220,
      maxHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      padding: 0,
      zIndex: 10,
      transition: 'width 0.2s ease',
      overflow: 'hidden',
    }}>
      {/* Toggle header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 10px',
          background: '#2a2926',
          border: 'none',
          color: '#fac775',
          fontSize: 12,
          cursor: 'pointer',
          textAlign: 'left',
          whiteSpace: 'nowrap',
        }}
        title={collapsed ? 'Show agent list' : 'Hide agent list'}
      >
        <span style={{ fontSize: 14, flex: 'none' }}>{collapsed ? '📋' : '📋'}</span>
        {!collapsed && (
          <span className="px" style={{ flex: 1, textShadow: '1px 1px 0 #000' }}>
            Agents ({items.length})
          </span>
        )}
        {!collapsed && <span style={{ fontSize: 10, opacity: 0.6 }}>◀</span>}
      </button>

      {/* Agent rows */}
      {!collapsed && (
        <div style={{
          flex: 1, overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
          maxHeight: '52vh',
        }}>
          {items.map((hero) => (
            <AgentRow
              key={hero.sessionId}
              hero={hero}
              selected={selected === hero.sessionId}
              onClick={() => {
                select(hero.sessionId);
                getGameView()?.centerOnUnit(hero.sessionId);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({ hero, selected, onClick }: { hero: HeroSnapshot; selected: boolean; onClick: () => void }) {
  const badge = STATE_BADGE[hero.state];
  const task = hero.state === 'working' ? hero.toolDetail ?? hero.currentTool : undefined;
  const pct = typeof hero.contextTokens === 'number' ? 0 : 0; // context bar for now, can be replaced with estimation

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px',
        background: selected ? '#323130' : 'transparent',
        border: 'none',
        borderBottom: '1px solid #2a2926',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        color: '#d4d2c9',
        fontSize: 12,
        transition: 'background 0.12s ease',
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = '#2a2926';
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {/* Team color dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: teamColorHex(hero.teamColor),
        border: '1px solid rgba(0,0,0,.4)',
        flex: 'none',
      }} />

      {/* Name + task */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="px" style={{
          fontSize: 12,
          color: selected ? '#fac775' : '#d4d2c9',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {clip(hero.title, 16)}
        </div>
        {task && (
          <div style={{
            fontSize: 10, opacity: 0.55,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {clip(task, 20)}
          </div>
        )}
      </div>

      {/* State badge */}
      <span title={hero.state} style={{
        fontSize: 13, flex: 'none',
        color: badge.color,
      }}>
        {badge.emoji}
      </span>
    </button>
  );
}