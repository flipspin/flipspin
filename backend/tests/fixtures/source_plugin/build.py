"""An offline, dependency-free wheel for the independent protocol test peer."""
import base64
import hashlib
from pathlib import Path
import zipfile


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    filename = 'fake_source-1.0.0-py3-none-any.whl'
    files = {'fake_source.py': Path('plugin.py').read_bytes(),
             'fake-source.dist-info/METADATA': b'Metadata-Version: 2.1\nName: fake-source\nVersion: 1.0.0\n',
             'fake-source.dist-info/WHEEL': b'Wheel-Version: 1.0\nGenerator: fake\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
    # Wheel dist-info must match its distribution filename.
    files = {name.replace('fake-source.dist-info', 'fake_source-1.0.0.dist-info'): data for name, data in files.items()}
    records = [f'{name},sha256={base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")},{len(data)}'
               for name, data in files.items()]
    records.append('fake_source-1.0.0.dist-info/RECORD,,')
    files['fake_source-1.0.0.dist-info/RECORD'] = ('\n'.join(records) + '\n').encode()
    with zipfile.ZipFile(Path(wheel_directory) / filename, 'w') as wheel:
        for name, data in files.items():
            wheel.writestr(name, data)
    return filename
