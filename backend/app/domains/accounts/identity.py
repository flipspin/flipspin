"""Compatibility exports for account records and the token store.

Keep existing import paths bound to the same implementation objects.
Account persistence and mutations live in the concern modules below.
See docs/security.md#account-storage.
"""

import hashlib as hashlib
import logging as logging
import re as re
import secrets as secrets
import time as time
import unicodedata as unicodedata
import uuid as uuid
from dataclasses import dataclass as dataclass
from dataclasses import replace as replace
from pathlib import Path as Path
from typing import Literal as Literal

from app.domains.accounts import passwords as passwords
from app.domains.accounts.file_lock import AccountFileLock as AccountFileLock
from app.domains.accounts.records import _BAD_CREDENTIALS as _BAD_CREDENTIALS
from app.domains.accounts.records import _USERNAME_RE as _USERNAME_RE
from app.domains.accounts.records import LAST_SEEN_FLUSH_SECONDS as LAST_SEEN_FLUSH_SECONDS
from app.domains.accounts.records import SCHEMA_VERSION as SCHEMA_VERSION
from app.domains.accounts.records import TOKEN_BYTES as TOKEN_BYTES
from app.domains.accounts.records import USERNAME_MAX_LENGTH as USERNAME_MAX_LENGTH
from app.domains.accounts.records import USERNAME_MIN_LENGTH as USERNAME_MIN_LENGTH
from app.domains.accounts.records import AlreadyInitializedError as AlreadyInitializedError
from app.domains.accounts.records import DeviceRecord as DeviceRecord
from app.domains.accounts.records import IdentityError as IdentityError
from app.domains.accounts.records import InvalidCredentialsError as InvalidCredentialsError
from app.domains.accounts.records import InvalidUsernameError as InvalidUsernameError
from app.domains.accounts.records import LastDeviceError as LastDeviceError
from app.domains.accounts.records import LastOwnerError as LastOwnerError
from app.domains.accounts.records import UnknownDeviceError as UnknownDeviceError
from app.domains.accounts.records import UnknownUserError as UnknownUserError
from app.domains.accounts.records import UsernameRequiredError as UsernameRequiredError
from app.domains.accounts.records import UsernameTakenError as UsernameTakenError
from app.domains.accounts.records import UserRecord as UserRecord
from app.domains.accounts.records import WeakPasswordError as WeakPasswordError
from app.domains.accounts.records import _clean_label as _clean_label
from app.domains.accounts.records import clean_device_label as clean_device_label
from app.domains.accounts.records import clean_username as clean_username
from app.domains.accounts.records import hash_token as hash_token
from app.domains.accounts.records import normalize_role as normalize_role
from app.domains.accounts.records import normalize_username as normalize_username
from app.domains.accounts.store import TokenStore as TokenStore
from app.domains.accounts.store_format import _parse_device as _parse_device
from app.domains.accounts.store_format import _parse_row as _parse_row
from app.domains.accounts.store_persistence import logger as logger
from app.infra.files import PRIVATE as PRIVATE
from app.infra.identity import ANONYMOUS as ANONYMOUS
from app.infra.identity import LEGACY_OWNER as LEGACY_OWNER
from app.infra.identity import LOCAL_OWNER as LOCAL_OWNER
from app.infra.identity import ROLE_MEMBER as ROLE_MEMBER
from app.infra.identity import ROLE_OWNER as ROLE_OWNER
from app.infra.identity import ROLES as ROLES
from app.infra.identity import SENTINEL_PRINCIPALS as SENTINEL_PRINCIPALS
from app.infra.identity import UNKNOWN as UNKNOWN
from app.infra.identity import Principal as Principal
from app.infra.identity import is_real_user as is_real_user
from app.infra.migrations import read_json_store as read_json_store
from app.infra.migrations import refuse as refuse
from app.infra.migrations import validate_claim as validate_claim
from app.infra.migrations import write_json_store as write_json_store
from app.utils.clock import utc_now_iso as utc_now_iso
