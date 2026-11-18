//! Bounded media byte ranges and partial response metadata validation.

pub(super) const MAX_MEDIA_SLICE: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct MediaRange {
    pub(super) start: u64,
    pub(super) end: u64,
}

/// Only single, start-based byte ranges are supported. Never let an open or
/// oversized range turn a custom-scheme response into a whole-file allocation.
pub(super) fn media_slice_range(value: Option<&str>) -> Option<MediaRange> {
    let (start, end) = value
        .unwrap_or("bytes=0-")
        .strip_prefix("bytes=")?
        .split_once('-')?;
    let decimal = |s: &str| -> Option<u64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    let start = decimal(start)?;
    let cap = start.saturating_add(MAX_MEDIA_SLICE - 1);
    let end = if end.is_empty() {
        cap
    } else {
        decimal(end)?.min(cap)
    };
    (end >= start).then_some(MediaRange { start, end })
}

/// A 206 must describe a bounded part of a representation of known length.
pub(super) fn media_content_range(value: &str) -> Option<(MediaRange, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = end.parse().ok()?;
    let total: u64 = total.parse().ok()?;
    (start <= end && end < total && end - start < MAX_MEDIA_SLICE)
        .then_some((MediaRange { start, end }, total))
}

pub(super) fn local_range(value: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    // Local files also accept suffix ranges; remote slicing stays in
    // media_slice_range, as defined by the upstream transport.
    if let Some(suffix) = value.and_then(|v| v.strip_prefix("bytes=-")) {
        let count = suffix.parse::<u64>().ok()?.min(MAX_MEDIA_SLICE).min(size);
        return (count > 0).then_some((size - count, size - 1));
    }
    let range = media_slice_range(value)?;
    (range.start < size).then_some((range.start, range.end.min(size - 1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_ranges_are_closed_and_capped_without_overflow() {
        for (input, start, end) in [
            (None, 0, 1_048_575),
            (Some("bytes=0-"), 0, 1_048_575),
            (Some("bytes=0-1"), 0, 1),
            (Some("bytes=7-7"), 7, 7),
            (Some("bytes=0-4999999"), 0, 1_048_575),
            (Some("bytes=4000000-"), 4_000_000, 5_048_575),
            (Some("bytes=18446744073709551615-"), u64::MAX, u64::MAX),
        ] {
            assert_eq!(media_slice_range(input), Some(MediaRange { start, end }));
        }
        for input in [
            "",
            "items=0-1",
            "bytes=-2",
            "bytes=2-1",
            "bytes=0-1,4-5",
            "bytes=+1-2",
            "bytes=0-+2",
            "bytes=1-a",
            "bytes=18446744073709551616-",
        ] {
            assert_eq!(media_slice_range(Some(input)), None, "accepted {input}");
        }
    }

    #[test]
    fn media_content_ranges_require_a_known_total_and_bounded_length() {
        assert_eq!(
            media_content_range("bytes 4000000-4999999/5000000"),
            Some((
                MediaRange {
                    start: 4_000_000,
                    end: 4_999_999
                },
                5_000_000
            ))
        );
        for input in [
            "bytes 0-1048576/5000000",
            "bytes 2-1/5",
            "bytes 0-5/5",
            "bytes 0-0/0",
            "bytes 0-1/*",
            "bytes */5000000",
            "garbage",
        ] {
            assert_eq!(media_content_range(input), None, "accepted {input}");
        }
    }
}
