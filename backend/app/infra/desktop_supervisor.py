"""The desktop owns stdin's writer; EOF also stops a nest after a shell crash."""
import threading
from typing import TextIO


def watch_desktop(server, stream: TextIO) -> threading.Thread:
    def watch():
        # The shell never writes. Closing its pipe asks uvicorn to drain requests
        # and run lifespan cleanup, including on Windows without POSIX signals.
        stream.read()
        server.should_exit = True

    thread = threading.Thread(target=watch, name="desktop-supervisor", daemon=True)
    thread.start()
    return thread
