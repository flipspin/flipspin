"""Staged audio inspection and AAC packaging; never encode an AAC source."""
import json
import math
import re
import shutil
import subprocess
from pathlib import Path

from app.exceptions import SourceFailure
from app.infra.files import PRIVATE, write_json_atomic


def _ffprobe_beside(ffmpeg):
    sibling = Path(ffmpeg).with_name('ffprobe.exe' if str(ffmpeg).endswith('.exe') else 'ffprobe')
    return str(sibling) if sibling.is_file() else shutil.which('ffprobe')


def _probe_with_ffmpeg(path, ffmpeg, timeout):
    """The desktop installers ship ffmpeg alone; its input summary carries the same facts."""
    result = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-i', str(path)],
                            capture_output=True, timeout=timeout)
    text = result.stderr.decode('utf-8', 'replace')
    container = re.search(r'^Input #0, (.+?), from ', text, re.M)
    duration = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', text)
    stream = re.search(r'Stream #0:\d+\S*: Audio: (\w+)([^\n]*)', text)
    if not (container and duration and stream):
        raise ValueError('ffmpeg could not read audio')
    hours, minutes, seconds = duration.groups()
    bitrate = re.search(r', (\d+) kb/s', stream.group(2))
    return {'codec': stream.group(1), 'bit_rate': int(bitrate.group(1)) * 1000 if bitrate else None,
            'duration': int(hours) * 3600 + int(minutes) * 60 + float(seconds),
            'format_name': container.group(1)}


def probe(path, *, ffmpeg='ffmpeg', timeout=300):
    """Inspect the audio stream with ffprobe beside the configured ffmpeg, or ffmpeg alone."""
    binary = _ffprobe_beside(ffmpeg)
    try:
        if binary is None:
            facts = _probe_with_ffmpeg(path, ffmpeg, timeout)
            return _report(facts['codec'], facts['bit_rate'], facts['duration'], facts['format_name'])
        result = subprocess.run([binary, '-v', 'error', '-show_streams', '-show_format',
                                 '-select_streams', 'a:0', '-show_entries',
                                 'stream=codec_name,codec_type,duration,bit_rate:format=duration,format_name',
                                 '-of', 'json', str(path)], capture_output=True, timeout=timeout)
        if result.returncode:
            raise ValueError('ffprobe rejected audio')
        data = json.loads(result.stdout)
        stream = next(s for s in data['streams'] if s.get('codec_type') == 'audio')
        duration = float(stream.get('duration') or data.get('format', {}).get('duration') or 0)
        return _report(stream.get('codec_name'), stream.get('bit_rate'), duration,
                       data.get('format', {}).get('format_name', ''))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration, TypeError) as error:
        raise SourceFailure('Staged audio could not be inspected.') from error


def _report(codec, bitrate, duration, format_name):
    if not math.isfinite(duration) or duration <= 0 or not codec:
        raise ValueError('invalid audio stream')
    containers = format_name.split(',')
    return {'codec': codec, 'bitrate_bps': int(bitrate) if bitrate else None,
            'container': 'm4a' if 'm4a' in containers else containers[0], 'duration_s': duration}


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
