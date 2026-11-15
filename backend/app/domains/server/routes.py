import logging

from fastapi import APIRouter, Depends, HTTPException, Response

from app.dependencies import conditional, get_container
from app.infra.identity import Principal, require_owner
from app.domains.server.models import ConfigChanges, RestartRequest, RestartResponse, ServerConfigResponse
from app.domains.server.models import BackupEntry, BackupsResponse, SkipUpdateRequest, UpdateResponse
from app.domains.server.services import ServerConfigService

router = APIRouter(prefix="/api/server", tags=["server"], dependencies=[Depends(require_owner)])


def get_server_config(container=Depends(get_container)) -> ServerConfigService:
    return container.singleton("server_config", lambda: ServerConfigService(container))


@router.get("/config", response_model=ServerConfigResponse, response_model_exclude_unset=True)
@conditional(('config', 'jobs', 'helpers'))
def config(service: ServerConfigService = Depends(get_server_config)):
    return service.describe()


@router.put("/config", response_model=ServerConfigResponse, response_model_exclude_unset=True)
def update(data: ConfigChanges, service: ServerConfigService = Depends(get_server_config),
           owner: Principal = Depends(require_owner)):
    result = service.update(data.changes)
    if 'KROBI_ANALYSIS_AUTO' in data.changes:
        logging.getLogger(__name__).info('Analysis automatic processing principal=%s enabled=%s',
                                         owner.user_id, data.changes['KROBI_ANALYSIS_AUTO'])
    return result


@router.post("/restart", status_code=202, response_model=RestartResponse, response_model_exclude_unset=True)
async def restart(data: RestartRequest, service: ServerConfigService = Depends(get_server_config)):
    return service.restart(data.when)


@router.get("/update", response_model=UpdateResponse)
def read_update(container=Depends(get_container)):
    return container.get_update_checker().describe()


@router.post("/update/check", response_model=UpdateResponse, status_code=202,
             responses={200: {"model": UpdateResponse, "description": "Stored state (floor or disabled)"}})
def check_update(response: Response, container=Depends(get_container)):
    checker = container.get_update_checker()
    response.status_code = 202 if checker.check() else 200
    return checker.describe()


@router.put("/update/skip", response_model=UpdateResponse)
def skip_update(data: SkipUpdateRequest, container=Depends(get_container)):
    try:
        return container.get_update_checker().skip(data.version)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.delete("/update/skip", response_model=UpdateResponse)
def restore_update(container=Depends(get_container)):
    return container.get_update_checker().skip(None)


@router.get("/backups", response_model=BackupsResponse)
def list_backups(container=Depends(get_container)):
    return {"backups": container.get_backups().list_backups()}


@router.post("/backups", response_model=BackupEntry, status_code=201)
def backup_now(container=Depends(get_container)):
    from app.infra.data_lock import DataBusy

    try:
        return container.get_backups().backup_now('manual')
    except DataBusy as error:
        raise HTTPException(status_code=409, detail="backup-in-progress") from error
    except Exception as error:
        raise HTTPException(status_code=503, detail="backup-failed") from error
