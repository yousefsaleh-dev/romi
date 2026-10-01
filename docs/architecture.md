# ROMI architecture

The complete, current design—including scope, data model, booking constraints, AI tools, session lifecycle, security boundaries, and verification limits—is maintained in [system-design.md](system-design.md).

The short path through the system is:

```text
ESP32 native voice / admin browser / phone fallback ⇄ Gemini Live
             │ tool calls + short-lived token
             ▼
          Next.js API
             ▼
        Supabase DB
             │ physical command queue
             ▼
       ESP32 polling + acknowledgement
```

Audio and full transcripts are not persisted. The AI model cannot directly control the door. ESP32 core and native audio firmware are implemented and build, but have not been flashed or physically verified; see [ESP32 integration](esp32-integration.md). HTTP request and response contracts are in [api.md](api.md).

Plan A is the standalone ESP32 full profile: the GPIO33 button requests a token from ROMI, drives native I2S audio and executes tool requests using the existing device routes. Plan B uses a phone with `/dashboard/kiosk` as the microphone, speaker and Gemini Live client. The operator supplies the device bearer token in page memory; existing AI routes then bind the session to `kiosk` and create physical commands. The browser reads door status only, while the ESP32 claims and acknowledges commands. `/dashboard/simulation` uses admin-cookie sessions and simulated commands. No backend routes or database changes are needed for this fallback.
