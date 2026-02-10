"""
CrypTonic — PGP Key Service

Reusable service layer for PGP key operations: create, load, list,
validate, renew, revoke, change passphrase, import, export, delete.
"""

import glob
import os
import re
from datetime import datetime, timedelta, timezone

import pgpy
from pgpy import PGPKey, PGPSignature, PGPUID
from pgpy.constants import (
    CompressionAlgorithm,
    HashAlgorithm,
    KeyFlags,
    PubKeyAlgorithm,
    SignatureType,
    SymmetricKeyAlgorithm,
)
from pgpy.packet.packets import PrivSubKeyV4

KEYS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "keys")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _fmt(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC") if dt else "never"


def _uid_str(uid) -> str:
    """Format a PGPUID as 'Name (Comment) <email>'."""
    if uid is None:
        return ""
    parts = [uid.name] if uid.name else []
    if uid.comment:
        parts.append(f"({uid.comment})")
    if uid.email:
        parts.append(f"<{uid.email}>")
    return " ".join(parts)


def get_subkey_expiry(subkey):
    """Read KeyExpirationTime from a subkey's binding signature."""
    for sig in subkey._signatures:
        if sig.type == SignatureType.Subkey_Binding and sig.key_expiration is not None:
            return subkey.created + sig.key_expiration
    return None


def _iso(dt) -> str | None:
    """Return ISO-8601 string or None."""
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _key_info(key, slug: str) -> dict:
    """Build a dict of key metadata."""
    created = key.created
    expires = key.expires_at
    uid = key.userids[0] if key.userids else None

    # Check for private key on disk
    priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    has_private = os.path.exists(priv_path)

    subkeys = []
    for kid, sub in key.subkeys.items():
        sub_exp = get_subkey_expiry(sub)
        subkeys.append({
            "key_id": str(kid),
            "algorithm": f"RSA {sub.key_size}",
            "created": _fmt(sub.created),
            "created_iso": _iso(sub.created),
            "expires": _fmt(sub_exp),
            "expires_iso": _iso(sub_exp),
            "is_expired": sub_exp is not None and sub_exp < datetime.now(timezone.utc),
        })

    is_expired = expires is not None and expires < datetime.now(timezone.utc)

    return {
        "slug": slug,
        "key_id": str(key.fingerprint.keyid),
        "fingerprint": str(key.fingerprint),
        "algorithm": f"RSA {key.key_size}",
        "created": _fmt(created),
        "created_iso": _iso(created),
        "expires": _fmt(expires),
        "expires_iso": _iso(expires),
        "is_expired": is_expired,
        "user_id": _uid_str(uid) if uid else None,
        "name": uid.name if uid else None,
        "email": uid.email if uid else None,
        "comment": uid.comment if uid else None,
        "is_protected": key.is_protected,
        "has_private_key": has_private,
        "subkeys": subkeys,
    }


# ── List ─────────────────────────────────────────────────────────────────────

def list_keys() -> list[dict]:
    """List all key pairs found in KEYS_DIR."""
    os.makedirs(KEYS_DIR, exist_ok=True)
    slugs = set()
    for path in glob.glob(os.path.join(KEYS_DIR, "*_public.asc")):
        fname = os.path.basename(path)
        slug = fname.rsplit("_public.asc", 1)[0]
        slugs.add(slug)

    results = []
    for slug in sorted(slugs):
        try:
            pub, _ = PGPKey.from_file(os.path.join(KEYS_DIR, f"{slug}_public.asc"))
            results.append(_key_info(pub, slug))
        except Exception as exc:
            results.append({"slug": slug, "error": str(exc)})
    return results


# ── Load ─────────────────────────────────────────────────────────────────────

def load_public(slug: str) -> PGPKey:
    path = os.path.join(KEYS_DIR, f"{slug}_public.asc")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Public key not found: {slug}")
    key, _ = PGPKey.from_file(path)
    return key


def load_private(slug: str) -> PGPKey:
    path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Private key not found: {slug}")
    key, _ = PGPKey.from_file(path)
    return key


def get_key_details(slug: str) -> dict:
    pub = load_public(slug)
    priv_exists = os.path.exists(os.path.join(KEYS_DIR, f"{slug}_private.asc"))
    info = _key_info(pub, slug)
    info["has_private_key"] = priv_exists
    return info



# ── Create ─────────────────────────────────────────────────────────────────

def create_key(name: str, email: str, comment: str, passphrase: str,
               key_size: int, expiry_days: int) -> dict:
    """Generate a new PGP key pair and save to disk."""
    if key_size not in (2048, 4096):
        raise ValueError("key_size must be 2048 or 4096")
    if expiry_days < 1:
        raise ValueError("expiry_days must be >= 1")

    primary = PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, key_size)
    uid = PGPUID.new(name, comment=comment, email=email)

    primary.add_uid(
        uid,
        usage={KeyFlags.Sign, KeyFlags.Certify},
        hashes=[HashAlgorithm.SHA512, HashAlgorithm.SHA384, HashAlgorithm.SHA256],
        ciphers=[SymmetricKeyAlgorithm.AES256, SymmetricKeyAlgorithm.AES192,
                 SymmetricKeyAlgorithm.AES128],
        compression=[CompressionAlgorithm.ZLIB, CompressionAlgorithm.BZ2,
                     CompressionAlgorithm.ZIP, CompressionAlgorithm.Uncompressed],
        key_expiration=timedelta(days=expiry_days),
        primary=True,
    )

    # Encryption subkey with expiration (manual binding)
    enc_subkey = PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, key_size)
    npk = PrivSubKeyV4()
    npk.pkalg = enc_subkey._key.pkalg
    npk.created = enc_subkey._key.created
    npk.keymaterial = enc_subkey._key.keymaterial
    enc_subkey._key = npk
    enc_subkey._key.update_hlen()

    primary._children[enc_subkey.fingerprint.keyid] = enc_subkey
    enc_subkey._parent = primary

    sig = PGPSignature.new(SignatureType.Subkey_Binding, primary.key_algorithm,
                           None, primary.fingerprint.keyid)
    sig._signature.subpackets.addnew("KeyFlags", hashed=True,
        flags={KeyFlags.EncryptCommunications, KeyFlags.EncryptStorage})
    sig._signature.subpackets.addnew("KeyExpirationTime", hashed=True,
        expires=timedelta(days=expiry_days))
    bsig = primary._sign(enc_subkey, sig)
    enc_subkey |= bsig

    primary.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)

    # Save to disk
    slug = _slug(name)
    os.makedirs(KEYS_DIR, exist_ok=True)
    pub_path = os.path.join(KEYS_DIR, f"{slug}_public.asc")
    priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    info_path = os.path.join(KEYS_DIR, f"{slug}_info.txt")

    with open(pub_path, "w") as f:
        f.write(str(primary.pubkey))
    with open(priv_path, "w") as f:
        f.write(str(primary))
    os.chmod(priv_path, 0o600)

    # Info file
    lines = [
        f"Key ID        : {primary.fingerprint.keyid}",
        f"Fingerprint   : {primary.fingerprint}",
        f"Algorithm     : RSA {key_size}",
        f"Created       : {_fmt(primary.created)}",
        f"Expires       : {_fmt(primary.expires_at)}",
        f"User ID       : {uid}",
    ]
    for kid, sub in primary.subkeys.items():
        sub_exp = get_subkey_expiry(sub)
        lines.append(f"Subkey ID     : {kid} (encryption)")
        lines.append(f"Subkey Expires: {_fmt(sub_exp)}")
    with open(info_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    return _key_info(primary.pubkey, slug)


# ── Validate ───────────────────────────────────────────────────────────────

def validate_key(slug: str, passphrase: str | None = None) -> dict:
    """Run validation checks on a key pair."""
    checks = []

    # 1. Load public key
    try:
        pub = load_public(slug)
        checks.append({"check": "public_key_readable", "ok": True})
    except Exception as exc:
        checks.append({"check": "public_key_readable", "ok": False, "detail": str(exc)})
        return {"slug": slug, "valid": False, "checks": checks}

    # 2. Expiry check
    expires = pub.expires_at
    if expires is None:
        checks.append({"check": "not_expired", "ok": True, "detail": "No expiration set"})
    elif expires < datetime.now(timezone.utc):
        checks.append({"check": "not_expired", "ok": False,
                        "detail": f"Expired on {_fmt(expires)}"})
    else:
        checks.append({"check": "not_expired", "ok": True,
                        "detail": f"Expires {_fmt(expires)}"})

    # 3. Self-signature verification
    uid = pub.userids[0] if pub.userids else None
    if uid:
        try:
            verified = pub.verify(uid)
            sig_ok = bool(verified)
            checks.append({"check": "self_signature_valid", "ok": sig_ok})
        except Exception as exc:
            checks.append({"check": "self_signature_valid", "ok": False,
                            "detail": str(exc)})
    else:
        checks.append({"check": "self_signature_valid", "ok": False,
                        "detail": "No UID found"})

    # 4. Private key exists
    priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    priv_exists = os.path.exists(priv_path)
    checks.append({"check": "private_key_exists", "ok": priv_exists})

    # 5. Pub/priv fingerprint match
    if priv_exists:
        try:
            priv = load_private(slug)
            fp_match = str(pub.fingerprint) == str(priv.fingerprint)
            checks.append({"check": "fingerprint_match", "ok": fp_match})
        except Exception as exc:
            checks.append({"check": "fingerprint_match", "ok": False,
                            "detail": str(exc)})
            priv = None
    else:
        priv = None

    # 6. Passphrase unlock
    if passphrase is not None and priv is not None:
        try:
            with priv.unlock(passphrase):
                checks.append({"check": "passphrase_unlock", "ok": True})
        except Exception:
            checks.append({"check": "passphrase_unlock", "ok": False,
                            "detail": "Incorrect passphrase"})
    elif passphrase is not None:
        checks.append({"check": "passphrase_unlock", "ok": False,
                        "detail": "No private key to test"})

    all_ok = all(c["ok"] for c in checks)
    return {"slug": slug, "valid": all_ok, "checks": checks}


# ── Delete ─────────────────────────────────────────────────────────────────

def delete_key(slug: str) -> dict:
    """Delete all files for a key pair."""
    removed = []
    for suffix in ("_public.asc", "_private.asc", "_info.txt", "_revocation.asc"):
        path = os.path.join(KEYS_DIR, f"{slug}{suffix}")
        if os.path.exists(path):
            os.remove(path)
            removed.append(os.path.basename(path))
    if not removed:
        raise FileNotFoundError(f"No key files found for slug: {slug}")
    return {"slug": slug, "removed": removed}


# ── Renew ──────────────────────────────────────────────────────────────────

def renew_key(slug: str, passphrase: str, new_expiry_days: int) -> dict:
    """Extend the expiration of a key pair by re-signing with a new expiry."""
    if new_expiry_days < 1:
        raise ValueError("new_expiry_days must be >= 1")

    priv = load_private(slug)

    with priv.unlock(passphrase):
        # Re-certify the UID with new expiration
        uid = priv.userids[0]
        # Remove old self-signatures on the UID
        uid._signatures = []
        priv.add_uid(
            uid,
            usage={KeyFlags.Sign, KeyFlags.Certify},
            hashes=[HashAlgorithm.SHA512, HashAlgorithm.SHA384, HashAlgorithm.SHA256],
            ciphers=[SymmetricKeyAlgorithm.AES256, SymmetricKeyAlgorithm.AES192,
                     SymmetricKeyAlgorithm.AES128],
            compression=[CompressionAlgorithm.ZLIB, CompressionAlgorithm.BZ2,
                         CompressionAlgorithm.ZIP, CompressionAlgorithm.Uncompressed],
            key_expiration=timedelta(days=new_expiry_days),
            primary=True,
        )

        # Re-sign subkeys with new expiration
        for kid, sub in priv.subkeys.items():
            sub._signatures = []
            sig = PGPSignature.new(SignatureType.Subkey_Binding, priv.key_algorithm,
                                   None, priv.fingerprint.keyid)
            sig._signature.subpackets.addnew("KeyFlags", hashed=True,
                flags={KeyFlags.EncryptCommunications, KeyFlags.EncryptStorage})
            sig._signature.subpackets.addnew("KeyExpirationTime", hashed=True,
                expires=timedelta(days=new_expiry_days))
            bsig = priv._sign(sub, sig)
            sub |= bsig

    # Save updated keys
    pub_path = os.path.join(KEYS_DIR, f"{slug}_public.asc")
    priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    with open(pub_path, "w") as f:
        f.write(str(priv.pubkey))
    with open(priv_path, "w") as f:
        f.write(str(priv))
    os.chmod(priv_path, 0o600)

    return _key_info(priv.pubkey, slug)


# ── Revoke ─────────────────────────────────────────────────────────────────

def revoke_key(slug: str, passphrase: str, reason: str = "Key revoked") -> dict:
    """Generate a revocation signature and save it."""
    priv = load_private(slug)

    with priv.unlock(passphrase):
        rev_sig = priv.revoke(priv.pubkey, sigtype=SignatureType.KeyRevocation)

    # Save revocation certificate
    rev_path = os.path.join(KEYS_DIR, f"{slug}_revocation.asc")
    with open(rev_path, "w") as f:
        f.write(str(rev_sig))

    return {"slug": slug, "revocation_file": rev_path, "revoked": True}


# ── Change Passphrase ──────────────────────────────────────────────────────

def change_passphrase(slug: str, old_passphrase: str, new_passphrase: str) -> dict:
    """Re-protect a private key with a new passphrase."""
    priv = load_private(slug)

    # Unlock with old passphrase, then re-protect with new
    with priv.unlock(old_passphrase):
        pass  # just verifying old passphrase works

    # PGPy requires unlocking to re-protect
    with priv.unlock(old_passphrase):
        priv.protect(new_passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)

    priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
    with open(priv_path, "w") as f:
        f.write(str(priv))
    os.chmod(priv_path, 0o600)

    return {"slug": slug, "passphrase_changed": True}


# ── Import ─────────────────────────────────────────────────────────────────

def import_key_pair(public_content: str, private_content: str | None = None,
                    passphrase: str | None = None) -> dict:
    """Import a PGP key pair from ASCII-armored text.

    Args:
        public_content: ASCII-armored public key (required).
        private_content: ASCII-armored private key (optional).
        passphrase: Passphrase to verify the private key (optional).
    """
    # Parse public key
    pub_key, _ = PGPKey.from_blob(public_content)
    if not pub_key.is_public:
        raise ValueError("The public key file contains a private key. "
                         "Please select the correct public key file.")

    uid = pub_key.userids[0] if pub_key.userids else None
    slug = _slug(uid.name) if uid else _slug(str(pub_key.fingerprint.keyid))

    os.makedirs(KEYS_DIR, exist_ok=True)

    # Save public key
    pub_path = os.path.join(KEYS_DIR, f"{slug}_public.asc")
    with open(pub_path, "w") as f:
        f.write(str(pub_key))

    # Handle private key if provided
    if private_content:
        priv_key, _ = PGPKey.from_blob(private_content)
        if priv_key.is_public:
            raise ValueError("The private key file contains a public key. "
                             "Please select the correct private key file.")

        # Verify fingerprints match
        if str(pub_key.fingerprint) != str(priv_key.fingerprint):
            raise ValueError(
                f"Key mismatch: public key fingerprint ({pub_key.fingerprint}) "
                f"does not match private key fingerprint ({priv_key.fingerprint})."
            )

        # Verify passphrase if provided
        if passphrase:
            try:
                with priv_key.unlock(passphrase):
                    pass
            except Exception:
                raise ValueError("Incorrect passphrase — could not unlock the private key.")

        # Save private key
        priv_path = os.path.join(KEYS_DIR, f"{slug}_private.asc")
        with open(priv_path, "w") as f:
            f.write(str(priv_key))
        os.chmod(priv_path, 0o600)

    return _key_info(pub_key, slug)


# ── Export ─────────────────────────────────────────────────────────────────

def export_key(slug: str, key_type: str = "public") -> str:
    """Return the ASCII-armored key content."""
    if key_type == "public":
        key = load_public(slug)
    elif key_type == "private":
        key = load_private(slug)
    else:
        raise ValueError("key_type must be 'public' or 'private'")
    return str(key)