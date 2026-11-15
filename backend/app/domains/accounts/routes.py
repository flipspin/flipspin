"""Compatibility exports and composition for account HTTP routers.

Keep the original router import path and endpoint names stable.
Each concern owns its handlers; the composition root still applies authentication.
See docs/security.md#account-routes.
"""

import logging as logging

from fastapi import APIRouter as APIRouter
from fastapi import Depends as Depends
from fastapi import HTTPException as HTTPException
from fastapi import Request as Request
from fastapi import status as status
from pydantic import BaseModel as BaseModel
from pydantic import Field as Field
from pydantic import field_validator as field_validator

from app.config import ConfigManager as ConfigManager
from app.dependencies import DependencyContainer as DependencyContainer
from app.dependencies import get_config as get_config
from app.dependencies import get_container as get_container
from app.dependencies import get_token_store as get_token_store
from app.domains.accounts import claim as claim
from app.domains.accounts import passwords as passwords
from app.domains.accounts.attention import AttentionResponse as AttentionResponse
from app.domains.accounts.attention import describe_attention as describe_attention
from app.domains.accounts.deletion import removable_files as removable_files
from app.domains.accounts.identity import ANONYMOUS as ANONYMOUS
from app.domains.accounts.identity import LEGACY_OWNER as LEGACY_OWNER
from app.domains.accounts.identity import LOCAL_OWNER as LOCAL_OWNER
from app.domains.accounts.identity import ROLE_MEMBER as ROLE_MEMBER
from app.domains.accounts.identity import ROLES as ROLES
from app.domains.accounts.identity import UNKNOWN as UNKNOWN
from app.domains.accounts.identity import AlreadyInitializedError as AlreadyInitializedError
from app.domains.accounts.identity import IdentityError as IdentityError
from app.domains.accounts.identity import InvalidCredentialsError as InvalidCredentialsError
from app.domains.accounts.identity import InvalidUsernameError as InvalidUsernameError
from app.domains.accounts.identity import LastDeviceError as LastDeviceError
from app.domains.accounts.identity import LastOwnerError as LastOwnerError
from app.domains.accounts.identity import Principal as Principal
from app.domains.accounts.identity import TokenStore as TokenStore
from app.domains.accounts.identity import UnknownDeviceError as UnknownDeviceError
from app.domains.accounts.identity import UnknownUserError as UnknownUserError
from app.domains.accounts.identity import UsernameRequiredError as UsernameRequiredError
from app.domains.accounts.identity import UsernameTakenError as UsernameTakenError
from app.domains.accounts.identity import UserRecord as UserRecord
from app.domains.accounts.identity import WeakPasswordError as WeakPasswordError
from app.domains.accounts.identity import clean_device_label as clean_device_label
from app.domains.accounts.identity import is_real_user as is_real_user
from app.domains.accounts.identity import normalize_role as normalize_role
from app.domains.accounts.requests import AddDeviceRequest as AddDeviceRequest
from app.domains.accounts.requests import ApproveSignInCodeRequest as ApproveSignInCodeRequest
from app.domains.accounts.requests import ChangePasswordRequest as ChangePasswordRequest
from app.domains.accounts.requests import ClaimRequest as ClaimRequest
from app.domains.accounts.requests import CreateUserRequest as CreateUserRequest
from app.domains.accounts.requests import LoginRequest as LoginRequest
from app.domains.accounts.requests import PollSignInCodeRequest as PollSignInCodeRequest
from app.domains.accounts.requests import RenameDeviceRequest as RenameDeviceRequest
from app.domains.accounts.requests import ResetPasswordRequest as ResetPasswordRequest
from app.domains.accounts.requests import SetLabelRequest as SetLabelRequest
from app.domains.accounts.requests import SetUsernameRequest as SetUsernameRequest
from app.domains.accounts.requests import SignInCodeRequest as SignInCodeRequest
from app.domains.accounts.routes_claim import ALREADY_CLAIMED_DETAIL as ALREADY_CLAIMED_DETAIL
from app.domains.accounts.routes_claim import claim_server as claim_server
from app.domains.accounts.routes_claim import router as routes_claim_router
from app.domains.accounts.routes_credentials import _BAD_LOGIN_DETAIL as _BAD_LOGIN_DETAIL
from app.domains.accounts.routes_credentials import DEFAULT_LOGIN_DEVICE_LABEL as DEFAULT_LOGIN_DEVICE_LABEL
from app.domains.accounts.routes_credentials import change_my_password as change_my_password
from app.domains.accounts.routes_credentials import login as login
from app.domains.accounts.routes_credentials import reset_account_password as reset_account_password
from app.domains.accounts.routes_credentials import router as routes_credentials_router
from app.domains.accounts.routes_credentials import set_my_username as set_my_username
from app.domains.accounts.routes_devices import add_my_api_key as add_my_api_key
from app.domains.accounts.routes_devices import add_my_app_password as add_my_app_password
from app.domains.accounts.routes_devices import add_my_device as add_my_device
from app.domains.accounts.routes_devices import list_my_devices as list_my_devices
from app.domains.accounts.routes_devices import list_user_devices as list_user_devices
from app.domains.accounts.routes_devices import rename_my_device as rename_my_device
from app.domains.accounts.routes_devices import revoke_my_device as revoke_my_device
from app.domains.accounts.routes_devices import revoke_user_device as revoke_user_device
from app.domains.accounts.routes_devices import router as routes_devices_router
from app.domains.accounts.routes_profile import SENTINEL_SOURCES as SENTINEL_SOURCES
from app.domains.accounts.routes_profile import SOURCE_TOKEN as SOURCE_TOKEN
from app.domains.accounts.routes_profile import _record_for as _record_for
from app.domains.accounts.routes_profile import complete_account_onboarding as complete_account_onboarding
from app.domains.accounts.routes_profile import read_attention as read_attention
from app.domains.accounts.routes_profile import router as routes_profile_router
from app.domains.accounts.routes_profile import set_my_label as set_my_label
from app.domains.accounts.routes_profile import whoami as whoami
from app.domains.accounts.routes_sign_in import _code_limited as _code_limited
from app.domains.accounts.routes_sign_in import _decide_sign_in_request as _decide_sign_in_request
from app.domains.accounts.routes_sign_in import approve_sign_in_code as approve_sign_in_code
from app.domains.accounts.routes_sign_in import approve_sign_in_request as approve_sign_in_request
from app.domains.accounts.routes_sign_in import decline_sign_in_request as decline_sign_in_request
from app.domains.accounts.routes_sign_in import decline_typed_sign_in_code as decline_typed_sign_in_code
from app.domains.accounts.routes_sign_in import inspect_sign_in_code as inspect_sign_in_code
from app.domains.accounts.routes_sign_in import list_sign_in_requests as list_sign_in_requests
from app.domains.accounts.routes_sign_in import poll_sign_in_code as poll_sign_in_code
from app.domains.accounts.routes_sign_in import request_sign_in_code as request_sign_in_code
from app.domains.accounts.routes_sign_in import router as routes_sign_in_router
from app.domains.accounts.routes_users import create_user as create_user
from app.domains.accounts.routes_users import deletion_preview as deletion_preview
from app.domains.accounts.routes_users import list_users as list_users
from app.domains.accounts.routes_users import require_account_owner as require_account_owner
from app.domains.accounts.routes_users import revoke_user as revoke_user
from app.domains.accounts.routes_users import router as routes_users_router
from app.domains.accounts.routes_users import set_user_label as set_user_label
from app.domains.accounts.schemas import CreateDeviceResponse as CreateDeviceResponse
from app.domains.accounts.schemas import CreateUserResponse as CreateUserResponse
from app.domains.accounts.schemas import DeletionPreviewResponse as DeletionPreviewResponse
from app.domains.accounts.schemas import DeviceListResponse as DeviceListResponse
from app.domains.accounts.schemas import DeviceListRow as DeviceListRow
from app.domains.accounts.schemas import LabelResponse as LabelResponse
from app.domains.accounts.schemas import MeResponse as MeResponse
from app.domains.accounts.schemas import OnboardedResponse as OnboardedResponse
from app.domains.accounts.schemas import PasswordChangeResponse as PasswordChangeResponse
from app.domains.accounts.schemas import RevokeDeviceResponse as RevokeDeviceResponse
from app.domains.accounts.schemas import RevokeUserResponse as RevokeUserResponse
from app.domains.accounts.schemas import SignInCodePollResponse as SignInCodePollResponse
from app.domains.accounts.schemas import SignInCodeResponse as SignInCodeResponse
from app.domains.accounts.schemas import SignInRequestResponse as SignInRequestResponse
from app.domains.accounts.schemas import SignInRequestsResponse as SignInRequestsResponse
from app.domains.accounts.schemas import SuccessResponse as SuccessResponse
from app.domains.accounts.schemas import UserListResponse as UserListResponse
from app.domains.accounts.schemas import UsernameResponse as UsernameResponse
from app.domains.accounts.sign_in_code import CodeRateLimit as CodeRateLimit
from app.domains.accounts.sign_in_code import DeclinedCode as DeclinedCode
from app.domains.accounts.sign_in_code import InvalidCode as InvalidCode
from app.domains.playlists.ownership import account_playlists as account_playlists
from app.domains.playlists.ownership import settle_account_playlists as settle_account_playlists
from app.infra import instance as nest_instance  # noqa: F401 - compatibility export
from app.infra import remote_access as remote_access
from app.infra.identity import current_principal as current_principal
from app.infra.identity import require_account as require_account
from app.infra.identity import require_owner as require_owner

router = APIRouter(prefix="/api", tags=["users"])
logger = logging.getLogger(__name__)
for _concern in (
    routes_profile_router,
    routes_devices_router,
    routes_credentials_router,
    routes_claim_router,
    routes_users_router,
    routes_sign_in_router,
):
    router.include_router(_concern)
# Preserve the published route order across concern routers.
_route_order = (
    "whoami",
    "read_attention",
    "list_my_devices",
    "add_my_device",
    "add_my_api_key",
    "add_my_app_password",
    "rename_my_device",
    "revoke_my_device",
    "login",
    "revoke_user_device",
    "set_my_username",
    "set_my_label",
    "change_my_password",
    "claim_server",
    "list_users",
    "list_user_devices",
    "set_user_label",
    "create_user",
    "deletion_preview",
    "revoke_user",
    "reset_account_password",
    "complete_account_onboarding",
    "request_sign_in_code",
    "poll_sign_in_code",
    "approve_sign_in_code",
    "list_sign_in_requests",
    "approve_sign_in_request",
    "decline_sign_in_request",
    "inspect_sign_in_code",
    "decline_typed_sign_in_code",
)
_route_positions = {name: position for position, name in enumerate(_route_order)}
router.routes.sort(key=lambda route: _route_positions.get(route.name, len(_route_order)))
