"""The sidecar owns one reversible correction, positive for sooner."""
import re

_OFFSET = re.compile(r"^\s*\[offset:([+-]?\d+)\]\s*$", re.I)
_HEADER = re.compile(r"^\s*\[[a-z]+:.*\]\s*$", re.I)


def read_offset(text: str) -> int:
    values = [int(m[1]) for line in text.splitlines() if (m := _OFFSET.fullmatch(line))]
    return values[-1] if values else 0


def set_offset(text: str, offset_ms: int) -> str:
    lines = text.splitlines(keepends=True)
    newline = "\r\n" if "\r\n" in text else "\n"
    tag = f"[offset:{offset_ms:+d}]"
    found = False
    result = []
    for line in lines:
        if _OFFSET.fullmatch(line):
            if offset_ms and not found:
                ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                result.append(tag + ending)
            found = True
        else:
            result.append(line)
    if offset_ms and not found:
        index = 0
        while index < len(result) and _HEADER.fullmatch(result[index]):
            index += 1
        if index and not result[index - 1].endswith("\n"):
            result[index - 1] += newline
        result.insert(index, tag + newline)
    return "".join(result)
