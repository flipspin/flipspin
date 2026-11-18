"""Pure mood rule calibrated to the helper's stored measurements."""

MOOD_RULE_VERSION = 2

# Quantile-matched to the previous librosa distribution on the same library.
ENERGY_AMBIENT_GROOVY_FLOOR = 0.093
ENERGY_UPBEAT_CALM_THRESHOLD = 0.123
ENERGY_AGGRESSIVE_THRESHOLD = 0.150
BRIGHTNESS_DARK_THRESHOLD = 0.094
BRIGHTNESS_MELANCHOLIC_THRESHOLD = 0.108
BRIGHTNESS_UPBEAT_THRESHOLD = 0.119
BRIGHTNESS_AMBIENT_THRESHOLD = 0.132
BRIGHTNESS_ROMANTIC_THRESHOLD = 0.144
PULSE_GROOVY_THRESHOLD = 0.877


def _classify_mood(bpm: float | None, energy: float, brightness: float, pulse: float) -> str:
    bpm_value = bpm or 0

    if energy < ENERGY_AMBIENT_GROOVY_FLOOR and brightness < BRIGHTNESS_AMBIENT_THRESHOLD:
        return "ambient"
    if bpm_value >= 138 and energy >= ENERGY_AGGRESSIVE_THRESHOLD:
        return "aggressive"
    if bpm_value >= 118 and energy >= ENERGY_UPBEAT_CALM_THRESHOLD and brightness >= BRIGHTNESS_UPBEAT_THRESHOLD:
        return "upbeat"
    if 95 <= bpm_value <= 128 and pulse >= PULSE_GROOVY_THRESHOLD and energy >= ENERGY_AMBIENT_GROOVY_FLOOR:
        return "groovy"
    if bpm_value <= 92 and energy < ENERGY_UPBEAT_CALM_THRESHOLD:
        return "calm"
    if bpm_value <= 110 and brightness < BRIGHTNESS_MELANCHOLIC_THRESHOLD:
        return "melancholic"
    if bpm_value <= 125 and brightness < BRIGHTNESS_ROMANTIC_THRESHOLD:
        return "romantic"
    return "dark" if brightness < BRIGHTNESS_DARK_THRESHOLD else "upbeat"
