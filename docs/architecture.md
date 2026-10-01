# ROMI architecture

The complete, current design—including scope, data model, booking constraints, AI tools, session lifecycle, security boundaries, and verification limits—is maintained in [system-design.md](system-design.md).

The short path through the system is:

```text
Admin browser / future kiosk ⇄ Gemini Live
             │ tool calls + short-lived token
             ▼
          Next.js API
             ▼
        Supabase DB
             │ physical command queue
             ▼
       ESP32 polling + acknowledgement
```

Audio and full transcripts are not persisted. The AI model cannot directly control the door. The ESP32 core firmware is implemented but has not been flashed or physically verified; see [ESP32 integration](esp32-integration.md). HTTP request and response contracts are in [api.md](api.md).
