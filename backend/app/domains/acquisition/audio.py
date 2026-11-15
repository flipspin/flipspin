"""Staged audio inspection and AAC packaging; never encode an AAC source."""
import json
import math
import shutil
import subprocess
from pathlib import Path

from app.exceptions import SourceFailure
from app.infra.files import PRIVATE, write_json_atomic




def probe(path, *, ffmpeg='ffmpeg', timeout=300):
    """Inspect the audio stream, preferring ffprobe beside the configured ffmpeg."""
    sibling = Path(ffmpeg).with_name('ffprobe.exe' if str(ffmpeg).endswith('.exe') else 'ffprobe')
    binary = str(sibling) if sibling.is_file() else (shutil.which('ffprobe') or 'ffprobe')
    try:
        result = subprocess.run([binary, '-v', 'error', '-show_streams', '-show_format',
                                 '-select_streams', 'a:0', '-show_entries',
                                 'stream=codec_name,codec_type,duration,bit_rate:format=duration,format_name',
                                 '-of', 'json', str(path)], capture_output=True, timeout=timeout)
        if result.returncode:
            raise ValueError('ffprobe rejected audio')
        data = json.loads(result.stdout)
        stream = next(s for s in data['streams'] if s.get('codec_type') == 'audio')
        duration = float(stream.get('duration') or data.get('format', {}).get('duration') or 0)
        if not math.isfinite(duration) or duration <= 0 or not stream.get('codec_name'):
            raise ValueError('invalid audio stream')
        bitrate = stream.get('bit_rate')
        containers = data.get('format', {}).get('format_name', '').split(',')
        return {'codec': stream['codec_name'], 'bitrate_bps': int(bitrate) if bitrate else None,
                'container': 'm4a' if 'm4a' in containers else containers[0], 'duration_s': duration}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration, TypeError) as error:
        raise SourceFailure('Staged audio could not be inspected.') from error


def validate(path, *, expected_duration=None, ffmpeg='ffmpeg', timeout=300):
    """Check duration and decode every audio packet before library visibility."""
    try:
        report = probe(path, ffmpeg=ffmpeg, timeout=timeout)
        if expected_duration and report['duration_s'] < expected_duration * 0.9:
            raise SourceFailure('Staged audio is shorter than the matched recording.',
                                {'duration_s': report['duration_s'], 'expected_duration_s': expected_duration})
        result = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-i', str(path),
                                 '-map', '0:a:0', '-f', 'null', '-'], capture_output=True, timeout=timeout)
        if result.returncode:
            raise SourceFailure('Staged audio could not be decoded.')
        return report
    except (OSError, subprocess.SubprocessError) as error:
        raise SourceFailure('Staged audio could not be decoded.') from error


def receipt(path):
    return Path(path).with_suffix('.acquisition.json')


def prepare_m4a(path, *, ffmpeg, timeout):
    """Copy AAC; only a source without AAC needs the 256 kbps encoder."""
    source = probe(path, ffmpeg=ffmpeg, timeout=timeout)
    transcoded = source['codec'] != 'aac'
    target = path.with_suffix('.m4a')
    try:
        result = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(path),
                                 '-map', '0:a:0', '-vn', '-c:a', 'aac' if transcoded else 'copy',
                                 *(['-b:a', '256k'] if transcoded else []), str(target)],
                                capture_output=True, timeout=timeout)
        if result.returncode:
            raise SourceFailure('Could not package staged audio as m4a.')
        write_json_atomic(receipt(target), {'source_codec': source['codec'], 'transcoded': transcoded}, mode=PRIVATE)
        path.unlink()
        return target
    except BaseException:
        target.unlink(missing_ok=True)
        raise
