# MVP-3 — Interaktywna kontrola Hermesa (Chat + Zarządzanie)

**Wersja:** 0.2.0
**Data:** 2026-07-26
**Zależność:** MVP-1 (adapter SQLite), MVP-2 (klikalni agenci, panel)

## Cel MVP-3

Dać użytkownikowi pełną, dwustronną komunikację z Hermesem przez interfejs Age of Agents:
- Wysyłanie wiadomości do Hermesa i **otrzymywanie odpowiedzi**
- Prowadzenie **ciągłej konwersacji** (historia sesji)
- **Zatrzymywanie** działających tasków
- **Podgląd live** tego co robi agent (tool calls)

## Procesy biznesowe

### Flow 1: Nowa rozmowa z agentem

```mermaid
sequenceDiagram
    actor U as Użytkownik
    participant UI as Agent Panel (React)
    participant API as Server (Fastify)
    participant H as Hermes CLI

    U->>UI: Klika agenta → wpisuje wiadomość → Enter
    UI->>API: POST /api/hermes/chat {message: "co robisz?"}
    API->>H: spawn hermes chat -Q -q "co robisz?"
    H-->>API: session_id + odpowiedź (stdout)
    API-->>UI: {session_id, response, tool_calls}
    UI-->>U: Pokazuje odpowiedź w panelu
```

### Flow 2: Kontynuacja rozmowy

```mermaid
sequenceDiagram
    actor U as Użytkownik
    participant UI as Agent Panel
    participant API as Server
    participant H as Hermes CLI

    U->>UI: Wpisuje follow-up → Enter
    UI->>API: POST /api/hermes/chat {session_id: "2026...", message: "a teraz?"}
    API->>H: spawn hermes chat -Q -q "a teraz?" --resume 2026...
    H-->>API: odpowiedź (kontynuacja sesji)
    API-->>UI: {response, tool_calls}
    UI-->>U: Pokazuje w historii
```

### Flow 3: Zatrzymanie tasku

```mermaid
sequenceDiagram
    actor U as Użytkownik
    participant UI as Agent Panel
    participant API as Server

    U->>UI: Klika "Stop" przy aktywnym tasku
    UI->>API: POST /api/task/{pid}/stop
    API->>API: process.kill(pid)
    API-->>UI: {ok: true}
    UI-->>U: "Task zatrzymany"
```

## Funkcje MVP-3

| Funkcja | Opis |
|---------|------|
| Chat z odpowiedzią | Wysyłasz wiadomość → dostajesz odpowiedź Hermesa (nie fire-and-forget) |
| Historia konwersacji | Kolejne wiadomości w tej samej sesji przez `--resume` |
| Zatrzymywanie tasków | Przycisk Stop przy aktywnym tasku |
| Podgląd tool calls | W trakcie oczekiwania widać co Hermes robi (search_files, terminal...) |
| Lista aktywnych tasków | Panel pokazuje wszystkie running taski z PID i możliwością stop |