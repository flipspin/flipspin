"""Run retention and lease maintenance outside snapshot request handlers."""
import logging
import threading

logger = logging.getLogger(__name__)


class JobMaintenance:
    def __init__(self, tick, *, interval=60):
        self.tick, self.interval = tick, interval
        self.stop_event = threading.Event()
        self.thread = None
        self.wake_event = threading.Event()

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name='job-maintenance', daemon=True)
        self.thread.start()

    def wake(self):
        self.wake_event.set()

    def run(self):
        while not self.stop_event.is_set():
            self.wake_event.wait(self.interval)
            self.wake_event.clear()
            if self.stop_event.is_set():
                return
            try:
                self.tick()
            except Exception:
                logger.exception('Job maintenance failed')

    def stop(self):
        self.stop_event.set()
        self.wake_event.set()
        if self.thread:
            self.thread.join(timeout=5)
