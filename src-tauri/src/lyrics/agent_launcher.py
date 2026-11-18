"""Windows stdin control bridge to the helper's existing stop/bye path.

Kept in the shell so installed helpers need no protocol upgrade. EOF also
stops the helper if the shell disappears. No console signal is required.
"""
import importlib
import importlib.util
import sys
import threading

package = "krobi_helper" if importlib.util.find_spec("krobi_helper") else "krobi_lyrics"
agent_module = importlib.import_module(f"{package}.agent")
run = agent_module.Agent.run


def controlled_run(self, *args, **kwargs):
    def watch_parent():
        sys.stdin.buffer.read(1)
        self.stop()

    threading.Thread(target=watch_parent, name="shell-stop", daemon=True).start()
    return run(self, *args, **kwargs)


agent_module.Agent.run = controlled_run
raise SystemExit(importlib.import_module(f"{package}.cli").main())
