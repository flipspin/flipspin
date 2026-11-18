//! Artwork and bounded audio responses from app-owned local files.

use super::*;

pub(super) fn serve_art(
    request: &Request<Vec<u8>>,
    art: &krobi_offline::store::ArtRecord,
) -> ShellResult<Response<Vec<u8>>> {
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        std::fs::read(&art.path)?
    };
    if request.method() != Method::HEAD && body.len() as u64 != art.bytes {
        return Err(ShellError::Guard("local-file-truncated"));
    }
    let fallback = match art
        .media_path
        .split('?')
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    let mut reply = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            art.content_type.as_deref().unwrap_or(fallback),
        )
        .header(header::CONTENT_LENGTH, art.bytes.to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Type, ETag",
        );
    if let Some(etag) = &art.etag {
        reply = reply.header(header::ETAG, etag);
    }
    reply
        .body(body)
        .map_err(|e| ShellError::Message(e.to_string()))
}

pub(super) fn serve_local(
    request: &Request<Vec<u8>>,
    path: &std::path::Path,
    key: &str,
    etag: Option<&str>,
) -> ShellResult<Response<Vec<u8>>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let range = if request
        .headers()
        .get(header::IF_RANGE)
        .is_some_and(|v| Some(v.to_str().unwrap_or("")) != etag)
    {
        None
    } else {
        request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
    };
    let Some((start, end)) = local_range(range, size) else {
        return Ok(Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .expect("range response"));
    };
    let mut body = Vec::new();
    if request.method() != Method::HEAD {
        file.seek(SeekFrom::Start(start))?;
        file.take(end - start + 1).read_to_end(&mut body)?;
        if body.len() as u64 != end - start + 1 {
            return Err(ShellError::Guard("local-file-truncated"));
        }
    }
    let mime = match key
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    };
    let mut reply = Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag",
        );
    if let Some(etag) = etag {
        reply = reply.header(header::ETAG, etag);
    }
    reply
        .body(body)
        .map_err(|e| ShellError::Message(e.to_string()))
}
