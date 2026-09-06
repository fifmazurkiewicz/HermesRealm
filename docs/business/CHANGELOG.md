# HermesRealm — Lista zmian

## [0.2.0] — MVP-3 (w trakcie)

### 🎯 Cel
Dwustronna komunikacja z Hermesem — chat, historia konwersacji, zatrzymywanie tasków

### 📋 Zadania MVP-3
- [ ] `POST /api/hermes/chat` — wysyła wiadomość do Hermesa i zwraca odpowiedź
- [ ] `POST /api/task/:pid/stop` — zatrzymuje działający task
- [ ] `GET /api/tasks` — lista aktywnych tasków
- [ ] TaskTracker — klasa śledząca procesy Hermesa (PID → metadata)
- [ ] ChatPanel — nowy komponent czatu w UI (historia + input + tool calls)
- [ ] Przebudowa AgentPanel na tryb czatu z historią
- [ ] Obsługa `--resume` dla ciągłości konwersacji

### 📄 Dokumentacja
- [MVP-3 — Opis biznesowy](business/mvp3-chat-control.md)
- [MVP-3 — Architektura techniczna](../technical/mvp3-chat-control.md)

## [0.1.0] — MVP-1 (w trakcie)

### 🎯 Cel
Adapter danych Hermesa + wbudowane okno czatu w Electron

### 📋 Zadania MVP-1
- [x] Fork agentsmill/age-of-agents → fifmazurkiewicz/HermesRealm
- [x] Adapter SQLite: czytanie `D:\Hermes\state.db` (sessions, messages)
- [x] Mapowanie narzędzi Hermesa na warsztaty AoA
- [x] Stan maszyny: idle/thinking/working/returning/resting
- [x] Electron shell: okno aplikacji zamiast przeglądarki
- [ ] Okno czatu (tryb "Chat"): embedded Hermes CLI ← przeniesione do MVP-3
- [x] Podstawowa wizualizacja (placeholder motyw fantasy)

### 🔜 MVP-2 (zaimplementowane)
- [x] Klikalni agenci + panel przypisywania zadań
- [x] Pasek estymacji czasu
- [x] Podświetlenie aktywnych agentów
- [x] Panel listy agentów