"""Unit tests for TransferService (VLC)."""
import pytest
from unittest.mock import Mock

from app.domains.transfers.services import TransferService
from app.exceptions import TransferError, ValidationError


@pytest.fixture
def mock_transfer_repo():
    return Mock()


@pytest.fixture
def service(mock_transfer_repo):
    return TransferService(transfer_repo=mock_transfer_repo, config=Mock(), logger=Mock())


def _make_files(tmp_path, count=2):
    files = []
    for i in range(count):
        f = tmp_path / f"track{i}.mp3"
        f.write_bytes(b"x" * (10 + i))  # distinct, non-zero sizes
        files.append(f)
    return files


class TestSendToVlc:
    def test_sends_each_file(self, service, mock_transfer_repo, tmp_path):
        files = _make_files(tmp_path, 2)
        service.send_to_vlc(files, "10.0.0.5")
        assert mock_transfer_repo.send_to_vlc_http.call_count == 2

    def test_empty_files_raises(self, service):
        with pytest.raises(ValidationError):
            service.send_to_vlc([], "10.0.0.5")

    def test_missing_ip_raises(self, service, tmp_path):
        with pytest.raises(ValidationError):
            service.send_to_vlc(_make_files(tmp_path, 1), "")

    def test_skips_nonexistent_file(self, service, mock_transfer_repo, tmp_path):
        missing = tmp_path / "gone.mp3"
        service.send_to_vlc([missing], "10.0.0.5")
        mock_transfer_repo.send_to_vlc_http.assert_not_called()

    def test_send_failure_raises_transfer_error(self, service, mock_transfer_repo, tmp_path):
        files = _make_files(tmp_path, 1)
        mock_transfer_repo.send_to_vlc_http.side_effect = OSError("no route")
        with pytest.raises(TransferError):
            service.send_to_vlc(files, "10.0.0.5")
