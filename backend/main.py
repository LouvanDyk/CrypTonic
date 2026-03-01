"""
CrypTonic — FastAPI Backend

REST API for PGP key management.
"""

import io
import zipfile

from fastapi import FastAPI, Form, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional

import pgp_service as svc
import metadata_service as meta

app = FastAPI(title="CrypTonic", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response Models ──────────────────────────────────────────────

class CreateKeyRequest(BaseModel):
    name: str
    email: str
    comment: str = ""
    passphrase: str
    key_size: int = 4096
    expiry_days: int = 365


class ValidateRequest(BaseModel):
    passphrase: str | None = None


class RenewRequest(BaseModel):
    passphrase: str
    new_expiry_days: int


class RevokeRequest(BaseModel):
    passphrase: str
    reason: str = "Key revoked"


class ChangePassphraseRequest(BaseModel):
    old_passphrase: str
    new_passphrase: str


class GroupRequest(BaseModel):
    name: str
    color: str | None = None
    description: str = ""


class GroupUpdateRequest(BaseModel):
    name: str | None = None
    color: str | None = None
    description: str | None = None


class TagsRequest(BaseModel):
    tags: list[str]


class SetGroupRequest(BaseModel):
    group_id: str | None = None


# ── Key Endpoints ──────────────────────────────────────────────────────────

@app.get("/api/keys")
def list_keys():
    keys = svc.list_keys()
    # Enrich with groups and tags
    for k in keys:
        k["groups"] = meta.get_key_groups(k["slug"])
        k["tags"] = meta.get_tags(k["slug"])
    return keys


@app.post("/api/keys", status_code=201)
def create_key(req: CreateKeyRequest):
    try:
        result = svc.create_key(
            name=req.name, email=req.email, comment=req.comment,
            passphrase=req.passphrase, key_size=req.key_size,
            expiry_days=req.expiry_days,
        )
        meta.log_action(result["slug"], "created", f"RSA {req.key_size}, expires in {req.expiry_days}d")
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# NOTE: export-all must be before {slug} to avoid route conflict
@app.get("/api/keys/export-all")
def export_all_keys():
    """Export all keys as a zip file."""
    import os
    import glob
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(glob.glob(os.path.join(svc.KEYS_DIR, "*.asc"))):
            fname = os.path.basename(path)
            zf.write(path, fname)
        for path in sorted(glob.glob(os.path.join(svc.KEYS_DIR, "*_info.txt"))):
            fname = os.path.basename(path)
            zf.write(path, fname)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=cryptonic_keys_backup.zip"},
    )


# NOTE: import must be before {slug} to avoid route conflict
@app.post("/api/keys/import")
async def import_key(
    public_file: UploadFile = File(...),
    private_file: Optional[UploadFile] = File(None),
    passphrase: Optional[str] = Form(None),
):
    try:
        public_content = (await public_file.read()).decode("utf-8")
        private_content = None
        if private_file is not None:
            private_content = (await private_file.read()).decode("utf-8")
        result = svc.import_key_pair(public_content, private_content, passphrase)
        meta.log_action(result["slug"], "imported",
                       f"{'with' if private_content else 'without'} private key")
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/keys/{slug}")
def get_key(slug: str):
    try:
        info = svc.get_key_details(slug)
        info["groups"] = meta.get_key_groups(slug)
        info["tags"] = meta.get_tags(slug)
        info["audit"] = meta.get_audit_log(slug)
        return info
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/keys/{slug}")
def delete_key(slug: str):
    try:
        result = svc.delete_key(slug)
        meta.cleanup_key_metadata(slug)
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/keys/{slug}/validate")
def validate_key(slug: str, req: ValidateRequest):
    try:
        result = svc.validate_key(slug, passphrase=req.passphrase)
        meta.log_action(slug, "validated", "passed" if result["valid"] else "failed")
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/keys/{slug}/renew")
def renew_key(slug: str, req: RenewRequest):
    try:
        result = svc.renew_key(slug, passphrase=req.passphrase,
                             new_expiry_days=req.new_expiry_days)
        meta.log_action(slug, "renewed", f"New expiry: {req.new_expiry_days}d")
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/keys/{slug}/revoke")
def revoke_key(slug: str, req: RevokeRequest):
    try:
        result = svc.revoke_key(slug, passphrase=req.passphrase, reason=req.reason)
        meta.log_action(slug, "revoked", req.reason)
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/keys/{slug}/change-passphrase")
def change_passphrase(slug: str, req: ChangePassphraseRequest):
    try:
        result = svc.change_passphrase(slug, old_passphrase=req.old_passphrase,
                                     new_passphrase=req.new_passphrase)
        meta.log_action(slug, "passphrase_changed")
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/keys/{slug}/export")
def export_key(slug: str, key_type: str = "public"):
    try:
        content = svc.export_key(slug, key_type=key_type)
        meta.log_action(slug, "exported", f"{key_type} key")
        return PlainTextResponse(content, media_type="application/pgp-keys")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ── Group Endpoints ────────────────────────────────────────────────────────

@app.get("/api/groups")
def list_groups():
    return meta.list_groups()


@app.post("/api/groups", status_code=201)
def create_group(req: GroupRequest):
    return meta.create_group(name=req.name, color=req.color, description=req.description)


@app.put("/api/groups/{group_id}")
def update_group(group_id: str, req: GroupUpdateRequest):
    try:
        return meta.update_group(group_id, name=req.name, color=req.color,
                                 description=req.description)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/groups/{group_id}")
def delete_group(group_id: str):
    try:
        return meta.delete_group(group_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.put("/api/keys/{slug}/group")
def set_key_group_endpoint(slug: str, req: SetGroupRequest):
    try:
        result = meta.set_key_group(slug, req.group_id)
        if req.group_id:
            meta.log_action(slug, "assigned_to_group", result["name"])
        else:
            meta.log_action(slug, "removed_from_group")
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/groups/{group_id}/keys/{slug}")
def add_key_to_group(group_id: str, slug: str):
    try:
        result = meta.add_key_to_group(group_id, slug)
        meta.log_action(slug, "added_to_group", result["name"])
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/groups/{group_id}/keys/{slug}")
def remove_key_from_group(group_id: str, slug: str):
    try:
        result = meta.remove_key_from_group(group_id, slug)
        meta.log_action(slug, "removed_from_group", result["name"])
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Tag Endpoints ──────────────────────────────────────────────────────────

@app.get("/api/tags")
def list_all_tags():
    return meta.all_tags()


@app.get("/api/keys/{slug}/tags")
def get_key_tags(slug: str):
    return meta.get_tags(slug)


@app.put("/api/keys/{slug}/tags")
def set_key_tags(slug: str, req: TagsRequest):
    result = meta.set_tags(slug, req.tags)
    meta.log_action(slug, "tags_updated", ", ".join(req.tags) if req.tags else "cleared")
    return result


# ── Audit Endpoints ────────────────────────────────────────────────────────

@app.get("/api/keys/{slug}/audit")
def get_audit_log(slug: str):
    return meta.get_audit_log(slug)
