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
import './hud/hud.css';

export function App() {
  return (
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
        <GameCanvas />
        <ThemeSwitch />
        <ResourceBar />
        <MissionLog />
        <NotificationFeed />
        <SidePanel />
        <AgentPanel />
        <AgentListPanel />
        <QuestionModal />
        <BuildingPanel />
        <ArchitectHall />
        <Portraits />
        <ZoomControls />
        <Minimap />
      </div>
    );
}
