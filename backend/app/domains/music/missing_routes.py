"""Owner-only missing-file review; member endpoints retain their own scope."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.dependencies import get_missing_files
from app.domains.music.tag_edits import TagError
from app.domains.music.tag_routes import failure, receipt
from app.domains.user_library.store import InvalidRelPathError
from app.exceptions import ValidationError
from app.infra.etags import strong_etag
from app.infra.identity import Principal, require_owner

router = APIRouter(prefix='/api/library/missing', tags=['music'])


class MissingAccount(BaseModel):
    id: str
    name: str


class MissingReferences(BaseModel):
    accounts: list[MissingAccount]
    playlists: list[str]
    playlistEntries: int
    corrections: list[str]
    plays: int
    likes: int
    lyric: bool
    analysis: bool
    stems: bool


class MissingRow(BaseModel):
    relPath: str
    path: str
    title: str
    size: int | None
    missingSince: str | None
    cause: str
    folder: str
    references: MissingReferences
    movedTo: str | None


class MissingListing(BaseModel):
    rows: list[MissingRow]
    libraryAvailable: bool
    libraryCount: int


class MissingSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPaths: list[str] = Field(min_length=1, max_length=500)


class MissingRemoval(MissingSelection):
    confirmLarge: bool = False


class MissingSearch(MissingSelection):
    folder: str | None = None
    target: str | None = None

    @model_validator(mode='after')
    def destination(self):
        if (self.folder is None) == (self.target is None) or (self.target is not None and len(self.relPaths) != 1):
            raise ValueError('Choose a folder or one target file')
        return self


class MissingMatch(BaseModel):
    relPath: str
    target: str | None
    rev: str | None
    reason: str | None


class MissingPreview(BaseModel):
    rows: list[MissingMatch]


class MissingApplyRow(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPath: str
    target: str
    rev: str


class MissingApply(BaseModel):
    model_config = ConfigDict(extra='forbid')
    rows: list[MissingApplyRow] = Field(min_length=1, max_length=500)


class MissingOutcomeRow(BaseModel):
    relPath: str
    state: str
    reason: str | None


class MissingOutcome(BaseModel):
    editId: str
    rows: list[MissingOutcomeRow]


def execute(action):
    try:
        return action()
    except TagError as error:
        failure(error)
    except (ValidationError, InvalidRelPathError, ValueError):
        raise HTTPException(422, {'reason': 'invalid-path'})
    except OSError:
        failure(TagError('write-failed', 500))


@router.get('', response_model=MissingListing)
def listing(request: Request, response: Response, principal: Principal = Depends(require_owner), service=Depends(get_missing_files)):
    body = service.rows()
    etag = strong_etag(body)
    headers = {'ETag': etag, 'Cache-Control': 'private, no-cache', 'Vary': 'Authorization'}
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return body


@router.post('/preview', response_model=MissingPreview)
def preview(body: MissingSearch, principal: Principal = Depends(require_owner), service=Depends(get_missing_files)):
    return execute(lambda: service.preview(body.relPaths, body.folder, body.target))


@router.post('/apply', response_model=MissingOutcome)
def apply(body: MissingApply, request: Request, principal: Principal = Depends(require_owner), service=Depends(get_missing_files)):
    return receipt(request, principal, service, body.model_dump(),
                   lambda: execute(lambda: service.apply([r.model_dump() for r in body.rows], principal.user_id)))


@router.post('/remove', response_model=MissingOutcome)
def remove(body: MissingRemoval, request: Request, principal: Principal = Depends(require_owner), service=Depends(get_missing_files)):
    return receipt(request, principal, service, body.model_dump(),
                   lambda: execute(lambda: service.remove(body.relPaths, principal.user_id, body.confirmLarge)))
