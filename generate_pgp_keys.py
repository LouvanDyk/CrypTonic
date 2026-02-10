#!/usr/bin/env python3
"""
CrypTonic — PGP Key Pair Generator

Generates an RSA PGP key pair (public + private) with:
  - Configurable key size (4096 or 2048 bits)
  - Passphrase protection (AES-256)
  - User-defined expiration period
  - Encryption subkey
  - ASCII-armored export to ./keys/

Requires: pip install PGPy
"""

import os
import sys
import getpass
from datetime import timedelta

import pgpy
from pgpy import PGPKey, PGPSignature, PGPUID
from pgpy.constants import (
    PubKeyAlgorithm,
    KeyFlags,
    HashAlgorithm,
    SignatureType,
    SymmetricKeyAlgorithm,
    CompressionAlgorithm,
)
from pgpy.packet.packets import PrivSubKeyV4

KEYS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "keys")


def get_subkey_expiry(subkey):
    """Read the KeyExpirationTime from a subkey's binding signature.

    PGPy's ``expires_at`` only checks UID self-signatures, so it always
    returns ``None`` for subkeys.  This helper inspects the Subkey Binding
    signature directly.
    """
    for sig in subkey._signatures:
        if sig.type == SignatureType.Subkey_Binding and sig.key_expiration is not None:
            return subkey.created + sig.key_expiration
    return None


# ── Helpers ──────────────────────────────────────────────────────────────────

def prompt(label, default=None):
    """Prompt the user for input with an optional default."""
    suffix = f" [{default}]" if default else ""
    value = input(f"  {label}{suffix}: ").strip()
    return value if value else default


def prompt_passphrase():
    """Prompt for a passphrase with confirmation."""
    while True:
        pp = getpass.getpass("  Passphrase: ")
        if not pp:
            print("  ⚠  Passphrase cannot be empty.")
            continue
        pp2 = getpass.getpass("  Confirm passphrase: ")
        if pp != pp2:
            print("  ⚠  Passphrases do not match. Try again.")
            continue
        return pp


def prompt_key_size():
    """Prompt for RSA key size."""
    while True:
        choice = input("  Key size — [1] 4096 bits (recommended)  [2] 2048 bits: ").strip()
        if choice in ("1", ""):
            return 4096
        if choice == "2":
            return 2048
        print("  ⚠  Please enter 1 or 2.")


def prompt_expiration():
    """Prompt for key expiration in days."""
    while True:
        raw = input("  Expiration in days [365]: ").strip()
        if not raw:
            return 365
        try:
            days = int(raw)
            if days < 1:
                raise ValueError
            return days
        except ValueError:
            print("  ⚠  Enter a positive integer.")


# ── Key Generation ───────────────────────────────────────────────────────────

def generate_key(name, email, comment, passphrase, key_size, expiry_days):
    """Generate a PGP primary key + encryption subkey."""
    print(f"\n⏳ Generating {key_size}-bit RSA primary key (this may take a moment)...")
    primary = PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, key_size)

    uid = PGPUID.new(name, comment=comment, email=email)

    # Add UID with signing/certify capabilities and expiration
    primary.add_uid(
        uid,
        usage={KeyFlags.Sign, KeyFlags.Certify},
        hashes=[
            HashAlgorithm.SHA512,
            HashAlgorithm.SHA384,
            HashAlgorithm.SHA256,
        ],
        ciphers=[
            SymmetricKeyAlgorithm.AES256,
            SymmetricKeyAlgorithm.AES192,
            SymmetricKeyAlgorithm.AES128,
        ],
        compression=[
            CompressionAlgorithm.ZLIB,
            CompressionAlgorithm.BZ2,
            CompressionAlgorithm.ZIP,
            CompressionAlgorithm.Uncompressed,
        ],
        key_expiration=timedelta(days=expiry_days),
        primary=True,
    )

    # Generate encryption subkey (same size as primary) with expiration.
    # PGPy's add_subkey() does not support key_expiration, so we manually
    # build the subkey binding signature with a KeyExpirationTime subpacket.
    print(f"⏳ Generating {key_size}-bit RSA encryption subkey...")
    enc_subkey = PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, key_size)

    # Convert the generated key into a subkey packet
    npk = PrivSubKeyV4()
    npk.pkalg = enc_subkey._key.pkalg
    npk.created = enc_subkey._key.created
    npk.keymaterial = enc_subkey._key.keymaterial
    enc_subkey._key = npk
    enc_subkey._key.update_hlen()

    # Attach subkey to primary
    primary._children[enc_subkey.fingerprint.keyid] = enc_subkey
    enc_subkey._parent = primary

    # Create a Subkey Binding signature that includes KeyExpirationTime
    sig = PGPSignature.new(
        SignatureType.Subkey_Binding,
        primary.key_algorithm,
        None,
        primary.fingerprint.keyid,
    )
    sig._signature.subpackets.addnew(
        "KeyFlags", hashed=True,
        flags={KeyFlags.EncryptCommunications, KeyFlags.EncryptStorage},
    )
    sig._signature.subpackets.addnew(
        "KeyExpirationTime", hashed=True,
        expires=timedelta(days=expiry_days),
    )
    bsig = primary._sign(enc_subkey, sig)
    enc_subkey |= bsig

    # Protect with passphrase
    primary.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)

    return primary


def save_keys(key, name_slug):
    """Export ASCII-armored public and private keys to ./keys/."""
    os.makedirs(KEYS_DIR, exist_ok=True)

    pub_path = os.path.join(KEYS_DIR, f"{name_slug}_public.asc")
    priv_path = os.path.join(KEYS_DIR, f"{name_slug}_private.asc")

    with open(pub_path, "w") as f:
        f.write(str(key.pubkey))

    with open(priv_path, "w") as f:
        f.write(str(key))

    # Restrict private key file permissions (owner read/write only)
    os.chmod(priv_path, 0o600)

    return pub_path, priv_path


def save_key_info(key, name_slug, expiry_days):
    """Write key metadata to a text file in ./keys/."""
    info_path = os.path.join(KEYS_DIR, f"{name_slug}_info.txt")

    created = key.created.strftime("%Y-%m-%d %H:%M:%S UTC")
    expires = (key.created + timedelta(days=expiry_days)).strftime("%Y-%m-%d %H:%M:%S UTC")

    lines = [
        f"Key ID        : {key.fingerprint.keyid}",
        f"Fingerprint   : {key.fingerprint}",
        f"Algorithm     : RSA {key.key_size}",
        f"Created       : {created}",
        f"Expires       : {expires} ({expiry_days} days)",
        f"User ID       : {key.userids[0]}",
    ]

    for kid, sub in key.subkeys.items():
        sub_exp = get_subkey_expiry(sub)
        sub_exp_str = sub_exp.strftime("%Y-%m-%d %H:%M:%S UTC") if sub_exp else "never"
        lines.append(f"Subkey ID     : {kid} (encryption)")
        lines.append(f"Subkey Expires: {sub_exp_str}")

    with open(info_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    return info_path


def display_summary(key, pub_path, priv_path, info_path, expiry_days):
    """Print key details to the console."""
    created = key.created.strftime("%Y-%m-%d %H:%M:%S UTC")
    expires = (key.created + timedelta(days=expiry_days)).strftime("%Y-%m-%d %H:%M:%S UTC")

    print("\n" + "═" * 60)
    print("  🔑  PGP KEY PAIR GENERATED SUCCESSFULLY")
    print("═" * 60)
    print(f"  Key ID        : {key.fingerprint.keyid}")
    print(f"  Fingerprint   : {key.fingerprint}")
    print(f"  Algorithm     : RSA {key.key_size}")
    print(f"  Created       : {created}")
    print(f"  Expires       : {expires} ({expiry_days} days)")
    print(f"  User ID       : {key.userids[0]}")

    # Show subkeys
    for kid, sub in key.subkeys.items():
        sub_exp = get_subkey_expiry(sub)
        sub_exp_str = sub_exp.strftime("%Y-%m-%d %H:%M:%S UTC") if sub_exp else "never"
        print(f"  Subkey ID     : {kid} (encryption)")
        print(f"  Subkey Expires: {sub_exp_str}")

    print("─" * 60)
    print(f"  Public key    : {pub_path}")
    print(f"  Private key   : {priv_path}")
    print(f"  Key info      : {info_path}")
    print("═" * 60)
    print("  ⚠  Keep your private key and passphrase safe!")
    print()


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print()
    print("═" * 60)
    print("  🔐  CrypTonic — PGP Key Pair Generator")
    print("═" * 60)
    print()

    # Gather user input
    name = prompt("Full name")
    if not name:
        print("  ⚠  Name is required.")
        sys.exit(1)

    email = prompt("Email address")
    if not email:
        print("  ⚠  Email is required.")
        sys.exit(1)

    comment = prompt("Comment (optional)", default="")
    key_size = prompt_key_size()
    expiry_days = prompt_expiration()
    passphrase = prompt_passphrase()

    # Generate
    key = generate_key(name, email, comment, passphrase, key_size, expiry_days)

    # Save
    name_slug = name.lower().replace(" ", "_")
    pub_path, priv_path = save_keys(key, name_slug)
    info_path = save_key_info(key, name_slug, expiry_days)

    # Summary
    display_summary(key, pub_path, priv_path, info_path, expiry_days)


if __name__ == "__main__":
    main()

