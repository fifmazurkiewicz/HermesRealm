import { GameCanvas } from './GameCanvas';
import { MissionLog } from './hud/MissionLog';
import { NotificationFeed } from './hud/NotificationFeed';
import { Minimap } from './hud/Minimap';
import { Portraits } from './hud/Portraits';
import { ResourceBar } from './hud/ResourceBar';
import { SidePanel } from './hud/SidePanel';
import { QuestionModal } from './hud/QuestionModal';
import { BuildingPanel } from './hud/BuildingPanel';
import { ThemeSwitch } from './hud/ThemeSwitch';
import { ZoomControls } from './hud/ZoomControls';
import { ArchitectHall } from './hud/ArchitectHall';
import { AgentPanel } from './hud/agent-panel';
import { AgentListPanel } from './hud/agent-list';
import { Component, type ReactNode } from 'react';
import './hud/hud.css';

/** Catches render errors so a single broken panel doesn't kill the whole app. */
class PanelGuard extends Component<{ children: ReactNode }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return null; // silently hide broken panel
    return this.props.children;
  }
}

export function App() {
  return (
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
        <GameCanvas />
        <ThemeSwitch />
        <ResourceBar />
        <MissionLog />
        <NotificationFeed />
        <SidePanel />
        <PanelGuard><AgentPanel /></PanelGuard>
        <PanelGuard><AgentListPanel /></PanelGuard>
        <QuestionModal />
        <BuildingPanel />
        <ArchitectHall />
        <Portraits />
        <ZoomControls />
        <Minimap />
      </div>
    );
}
