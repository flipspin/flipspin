"""Reference participants for reviewed missing removal and compensating undo.

Plugins may register the same snapshot/drop/restore port at composition time.
Snapshots must be JSON values; drop and restore must tolerate a retry.
"""
class LibraryKeys:
    def __init__(self):
        self.participants = {}

    def register(self, name, participant):
        if name in self.participants:
            raise ValueError('Duplicate library keys participant')
        self.participants[name] = participant

    def snapshot(self, rel):
        return {name: port.snapshot(rel) for name, port in self.participants.items()}

    def drop(self, rel, snapshot):
        for name, value in snapshot.items():
            self.participants[name].drop(rel, value)

    def restore(self, rel, snapshot):
        # Refuse before touching any store if a plugin is no longer installed.
        if snapshot.keys() - self.participants.keys():
            raise ValueError('Missing library keys participant')
        return {name: self.participants[name].restore(rel, value) for name, value in snapshot.items()}
