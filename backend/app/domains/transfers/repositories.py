"""Transfer repository: pushing files to VLC's HTTP upload endpoint."""
import logging
import requests
from pathlib import Path
from urllib.parse import urlparse

from app.config import APP_VERSION, ConfigManager
from app.exceptions import TransferError, ValidationError
from app.utils.path_safety import safe_open_path


class TransferRepository:
    """Repository for file transfer operations."""

    def __init__(self, config: ConfigManager, logger: logging.Logger):
        """
        Initialize transfer repository.
        
        Args:
            config: Configuration manager
            logger: Logger instance
        """
        self.config = config
        self.logger = logger
    
    def _vlc_upload_headers(self, vlc_upload_url: str) -> dict:
        """Build VLC upload headers while identifying KROBI honestly."""
        parsed = urlparse(vlc_upload_url)
        base = f"{parsed.scheme}://{parsed.hostname}"
        if parsed.port:
            base = f"{base}:{parsed.port}"
        return {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Origin": base,
            "Referer": base + "/",
            "User-Agent": f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )",
            "X-Requested-With": "XMLHttpRequest",
        }

    def send_to_vlc_http(self, vlc_ip: str, file_path: Path) -> None:
        """
        Send file to VLC via HTTP upload endpoint (upload.json).
        Uses same URL, headers and multipart format as legacy sendvlc/sendvlclist.
        """
        file_path = safe_open_path(self.config.base_music_dir, file_path)
        if not file_path.is_file():
            raise ValidationError('Not a regular file')
        try:
            if not file_path.exists():
                raise TransferError(f"File not found: {file_path}")
            url = f"http://{vlc_ip}/upload.json"
            headers = self._vlc_upload_headers(url)
            with open(file_path, "rb") as f:
                files = {"file": (file_path.name, f, "application/octet-stream")}
                response = requests.post(url, headers=headers, files=files, timeout=30)
                response.raise_for_status()
            self.logger.info(f"Sent {file_path.name} to VLC at {vlc_ip}")
        except requests.RequestException as e:
            self.logger.error(f"VLC upload error: {e}")
            raise TransferError(
                f"Failed to send to VLC: {str(e)}",
                details={"vlc_ip": vlc_ip, "file": str(file_path)},
            )
