"""Transfer service: sending library songs to VLC."""
import logging
from pathlib import Path

from app.config import ConfigManager
from app.exceptions import TransferError, ValidationError
from app.domains.transfers.repositories import TransferRepository


class TransferService:
    """Service for file transfer operations."""

    def __init__(
        self,
        transfer_repo: TransferRepository,
        config: ConfigManager,
        logger: logging.Logger
    ):
        self.transfer_repo = transfer_repo
        self.config = config
        self.logger = logger

    def send_to_vlc(
        self,
        files: list[Path],
        vlc_ip: str,
        mode: str = "single"
    ) -> None:
        """Send files through VLC's HTTP interface, validating transfer parameters first."""
        self.logger.info(f"Sending {len(files)} files to VLC at {vlc_ip}")
        
        if not files:
            raise ValidationError("No files to send")
        
        if not vlc_ip:
            raise ValidationError("VLC IP address is required")
        
        try:
            # Test VLC connectivity
            # This would be implemented in the repository
            # For now, just send files
            
            for file_path in files:
                if not file_path.exists():
                    self.logger.warning(f"File not found, skipping: {file_path}")
                    continue
                
                try:
                    self.transfer_repo.send_to_vlc_http(vlc_ip, file_path)
                    self.logger.info(f"Sent to VLC: {file_path}")
                except Exception as e:
                    self.logger.error(f"Failed to send {file_path} to VLC: {e}")
                    raise TransferError(f"VLC transfer failed: {str(e)}")
            
            self.logger.info(f"Successfully sent {len(files)} files to VLC")
            
        except Exception as e:
            self.logger.error(f"Error sending to VLC: {e}")
            raise TransferError(f"VLC transfer failed: {str(e)}")
