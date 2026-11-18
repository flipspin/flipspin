opus-probe.ogg is a synthetic 440 Hz sine, 40 ms, 48 kHz stereo Ogg/Opus.
It contains no recorded music. Generate with:

ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.04' -ac 2 -c:a libopus -b:a 16k -y opus-probe.ogg

The production engine decodes this fixture on the first user gesture, using
its shared AudioContext; a rejection produces unsupported / codec.
