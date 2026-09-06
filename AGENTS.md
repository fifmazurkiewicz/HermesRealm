# AGENTS.md — HermesRealm

## Stack
- **Runtime:** Node.js >= 22, Electron 34
- **Język:** TypeScript (strict)
- **Frontend:** React 19 + PixiJS v8 (silnik gry)
- **Backend:** Fastify 5 + WebSocket (ws)
- **Assets:** Pixel art PNG (PixelLab) + JSON (frame metadata)
- **Package manager:** npm (workspaces monorepo)
- **Testy:** Vitest (server + client)

## Struktura
```
packages/
  shared/       — typy WebSocket, BuildingId, mapping tool→building, model registry
  server/       — Fastify + WS, watcher sesji, state machine, CLI
  client/       — Vite + React 19 + PixiJS v8 (gra, HUD, panel)
  electron/     — Electron shell (dev + build)
docs/
  business/     — dokumentacja biznesowa (MVP, CHANGELOG)
  technical/    — architektura, ADR, plany MVP
  superpowers/  — oryginalne plany i specyfikacje z Age of Agents
assets-manifest.json  — manifest assetów (PixelLab)
scripts/              — download-assets.mjs, build-server.mjs, graphify.mjs
```

## Komendy
```bash
npm run dev           # server + client (dev)
npm run demo          # demo mode (fake sessions)
npm run electron:dev  # Electron app (dev)
npm run test          # vitest (server + client)
npm run build         # produkcja (web + server)
```

## Konwencje specyficzne dla tego projektu

### System motywów (ThemeDef)
- Każdy motyw to obiekt `ThemeDef` (types.ts) z `id`, `name`, `style`, `projection`, `tile`, `heroSprite`, `grid`, `buildings[]`, `crossroads[]`, `edges[]`, `terrain`
- Definicje w `theme/{id}.ts`, rejestracja w `theme/index.ts`
- `BuildingId` jest union type w `shared/src/index.ts` — każde nowe ID trzeba dodać do union + `BUILDING_IDS` + mapowania (HOME/AWAITING/COMPLETED/RECOVERY)
- Assety: `assets/{theme}/buildings/` (PNG+JSON per budynek), `heroes/`, `decorations/`, `tilemap-iso/`
- JSON budynku format: `{ frames: { main: { frame, sourceSize, spriteSourceSize } }, meta: { image, format, size, scale } }`

### i18n
- 3 języki: en, pl, it
- `ThemeId` i `BUILDINGS` w i18n.ts muszą być zsynchronizowane z rzeczywistymi motywami
- UI przełączania motywów w `ThemeSwitch.tsx` — obecnie na sztywno fantasy/scifi, trzeba przerobić na dynamiczne

### Git workflow
- Branch `hermes` → PR → merge przez właściciela (nigdy nie commituj bezpośrednio na main)
- Upstream: `agentsmill/age-of-agents` (do śledzenia zmian oryginału)

### Hermes integration
- Adapter czyta `D:\Hermes\state.db` (SQLite)
- Ścieżka DB konfigurowalna przez `AOA_HERMES_DB_PATH`
- Hermes Poller w `sources/hermes.ts`
- Task tracker w `task-tracker.ts`
- API: chat, stop task, list tasks (MVP-3)