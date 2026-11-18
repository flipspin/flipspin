"""``@unexpected_errors_as_500`` answers exactly what the hand-written catch-alls did."""
import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.infra.errors import INTERNAL_ERROR_DETAIL, unexpected_errors_as_500
from app.exceptions import ValidationError

router = APIRouter()


@router.get("/sync/{kind}")
@unexpected_errors_as_500
def sync_route(kind: str):
    """Docstring kept for the OpenAPI description."""
    if kind == "boom":
        raise RuntimeError("boom")
    if kind == "krobi":
        raise ValidationError("a domain error the route did not map")
    if kind == "404":
        raise HTTPException(status_code=404, detail="nope")
    return {"ok": kind}


@router.get("/async/{kind}")
@unexpected_errors_as_500
async def async_route(kind: str):
    if kind == "boom":
        raise RuntimeError("boom")
    if kind == "404":
        raise HTTPException(status_code=404, detail="nope")
    return {"ok": kind}


app = FastAPI()
app.include_router(router)
client = TestClient(app)


@pytest.mark.parametrize("prefix", ["sync", "async"])
def test_an_unexpected_error_is_the_generic_500(prefix, caplog):
    response = client.get(f"/{prefix}/boom")
    assert response.status_code == 500
    assert response.json() == {"detail": INTERNAL_ERROR_DETAIL}
    assert any(r.exc_info for r in caplog.records), "logged with its traceback"


def test_an_unmapped_domain_error_is_the_generic_500_too():
    response = client.get("/sync/krobi")
    assert response.status_code == 500
    assert response.json() == {"detail": INTERNAL_ERROR_DETAIL}


@pytest.mark.parametrize("prefix", ["sync", "async"])
def test_an_http_exception_passes_through(prefix):
    response = client.get(f"/{prefix}/404")
    assert response.status_code == 404
    assert response.json() == {"detail": "nope"}


@pytest.mark.parametrize("prefix", ["sync", "async"])
def test_success_and_signature_are_untouched(prefix):
    assert client.get(f"/{prefix}/fine").json() == {"ok": "fine"}
    operation = app.openapi()["paths"]["/sync/{kind}"]["get"]
    assert operation["operationId"].startswith("sync_route")
    assert operation["description"] == "Docstring kept for the OpenAPI description."
