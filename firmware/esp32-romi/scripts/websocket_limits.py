from pathlib import Path

Import("env")  # PlatformIO/SCons supplies this environment.


def allow_configured_frame_limit(build_env, node):
    header = Path(build_env.subst("$PROJECT_LIBDEPS_DIR")) / build_env.subst("$PIOENV") / "WebSockets/src/WebSockets.h"
    if not header.exists():
        return node
    original = "#define WEBSOCKETS_MAX_DATA_SIZE (15 * 1024)"
    guarded = "#ifndef WEBSOCKETS_MAX_DATA_SIZE\n" + original + "\n#endif"
    source = header.read_text(encoding="utf-8")
    if guarded not in source:
        if original not in source:
            raise RuntimeError("WebSockets 2.7.3 frame-limit definition changed; review the dependency patch")
        header.write_text(source.replace(original, guarded, 1), encoding="utf-8")
        print("ROMI: enabled the configured 64 KiB WebSocket frame bound (provider probe exceeded 15 KiB)")
    return node


env.AddBuildMiddleware(allow_configured_frame_limit)
