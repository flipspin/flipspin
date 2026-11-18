"""Logging configuration for the KROBI application."""
import logging
import logging.handlers
import json
import os
from datetime import UTC, datetime
from pathlib import Path
import contextvars
import re
from urllib.parse import unquote

# Context variable for request ID tracking
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    'request_id', default=None
)


_QUERY_VALUE = re.compile(r'''([?&])([^=&#\s]+)=([^&#\s"']*)''')
_QUERY_SECRETS = frozenset({"apiKey", "p", "t", "jwt"})


def _redact_query_credentials(value: str) -> str:
    return _QUERY_VALUE.sub(
        lambda match: f"{match[1]}{match[2]}=[REDACTED]"
        if unquote(match[2]) in _QUERY_SECRETS else match[0], value,
    )


def _redact_log_value(value):
    # HTTPX passes a URL object, whereas Uvicorn passes a string. Preserve
    # untouched objects and numbers so formatters still receive their types.
    text = str(value)
    redacted = _redact_query_credentials(text)
    return redacted if redacted != text else value


class CredentialQueryFilter(logging.Filter):
    """Subsonic URLs must not turn one-way verifiers into plaintext in logs.

    Keep positional args intact: Uvicorn's access formatter unpacks them.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact_log_value(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_log_value(v) for v in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: _redact_log_value(v) for k, v in record.args.items()}
        return True


class FileLogFilter(logging.Filter):
    """Keep console-only setup credentials out of files and log API responses."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not getattr(record, "console_only", False)


def _local_timestamp(created: float) -> datetime:
    """Use the process timezone when configured, otherwise keep UTC."""
    timestamp = datetime.fromtimestamp(created, UTC)
    return timestamp.astimezone() if "TZ" in os.environ else timestamp


class JSONFormatter(logging.Formatter):
    """JSON formatter for structured logging."""
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON."""
        log_data = {
            "timestamp": _local_timestamp(record.created).isoformat(),
            "level": record.levelname,
            "module": record.name,
            "message": record.getMessage(),
        }
        
        # Add request ID if available
        request_id = request_id_var.get()
        if request_id:
            log_data["request_id"] = request_id
        
        # Add exception info if present
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        
        # Add extra context if present
        if hasattr(record, "context"):
            log_data["context"] = record.context
        
        return json.dumps(log_data)


class ConsoleFormatter(logging.Formatter):
    """Human-readable formatter for console output."""
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record for console."""
        timestamp = _local_timestamp(record.created).isoformat(sep=" ", timespec="seconds")
        request_id = request_id_var.get()
        request_id_str = f" [{request_id}]" if request_id else ""
        
        message = f"{timestamp} {record.levelname:8s} {record.name}{request_id_str}: {record.getMessage()}"
        
        if record.exc_info:
            message += "\n" + self.formatException(record.exc_info)
        
        return message


class HTTPDetailFilter(logging.Filter):
    """The middleware owns incoming request lines; HTTPX details belong at debug."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access":
            return False
        if record.levelno == logging.INFO:
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
            return logging.getLogger().isEnabledFor(logging.DEBUG)
        return True


class LoggerConfig:
    """Configure structured logging for the application."""

    _detail_handlers: list[logging.Handler] = []

    @staticmethod
    def set_level(level: str) -> None:
        """Change detail live while keeping the separate errors file at ERROR."""
        logging.getLogger().setLevel(level)
        for handler in LoggerConfig._detail_handlers:
            handler.setLevel(level)
    
    @staticmethod
    def setup_logging(log_dir: Path, log_level: str = "INFO", use_json: bool = False) -> None:
        """
        Setup logging with console and file handlers.
        
        Args:
            log_dir: Directory for log files
            log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            use_json: Use JSON formatter for file logs (default: False for development)
        """
        log_dir.mkdir(parents=True, exist_ok=True)
        
        root_logger = logging.getLogger()
        root_logger.setLevel(getattr(logging, log_level.upper()))
        
        # Remove existing handlers
        root_logger.handlers.clear()
        
        # Console handler (human-readable)
        console_handler = logging.StreamHandler()
        console_handler.setLevel(getattr(logging, log_level.upper()))
        console_handler.setFormatter(ConsoleFormatter())
        root_logger.addHandler(console_handler)
        
        # File handler with rotation (JSON or human-readable)
        log_file = log_dir / "krobi.log"
        file_handler = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=5,
            encoding="utf-8"
        )
        file_handler.setLevel(getattr(logging, log_level.upper()))
        file_handler.addFilter(FileLogFilter())
        
        if use_json:
            file_handler.setFormatter(JSONFormatter())
        else:
            file_handler.setFormatter(ConsoleFormatter())
        
        root_logger.addHandler(file_handler)
        LoggerConfig._detail_handlers = [console_handler, file_handler]
        
        # Error file handler (always JSON for easier parsing)
        error_log_file = log_dir / "krobi_errors.log"
        error_handler = logging.handlers.RotatingFileHandler(
            error_log_file,
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=5,
            encoding="utf-8"
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.addFilter(FileLogFilter())
        error_handler.setFormatter(JSONFormatter())
        root_logger.addHandler(error_handler)

        for handler in root_logger.handlers:
            handler.addFilter(CredentialQueryFilter())
        # Uvicorn has its own non-propagating handler; install on the logger so
        # it also survives uvicorn.run() replacing that handler at startup.
        access_logger = logging.getLogger("uvicorn.access")
        if not any(isinstance(f, CredentialQueryFilter) for f in access_logger.filters):
            access_logger.addFilter(CredentialQueryFilter())
        
        for name in ("uvicorn.access", "httpx"):
            http_logger = logging.getLogger(name)
            if not any(isinstance(f, HTTPDetailFilter) for f in http_logger.filters):
                http_logger.addFilter(HTTPDetailFilter())

        # Log startup message
        logger = logging.getLogger(__name__)
        logger.info(f"Logging initialized at level {log_level}")
    
    @staticmethod
    def get_logger(name: str) -> logging.Logger:
        """
        Get a logger instance for a module.
        
        Args:
            name: Module name (typically __name__)
            
        Returns:
            Logger instance
        """
        return logging.getLogger(name)
    
    @staticmethod
    def set_request_id(request_id: str) -> None:
        """Set request ID for current context."""
        request_id_var.set(request_id)
    
    @staticmethod
    def clear_request_id() -> None:
        """Clear request ID from current context."""
        request_id_var.set(None)
    
    @staticmethod
    def log_with_context(logger: logging.Logger, level: int, message: str, **context) -> None:
        """
        Log a message with additional context.
        
        Args:
            logger: Logger instance
            level: Log level (logging.DEBUG, logging.INFO, etc.)
            message: Log message
            **context: Additional context to include in log
        """
        extra = {"context": context} if context else {}
        logger.log(level, message, extra=extra)
