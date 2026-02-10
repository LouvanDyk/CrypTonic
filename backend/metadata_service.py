"""
CrypTonic — Metadata Service

Manages groups, tags, and audit logs for PGP keys.
Stored in keys/metadata.json.
"""

import json
import os
import uuid
from datetime import datetime, timezone

KEYS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "keys")
META_FILE = os.path.join(KEYS_DIR, "metadata.json")

DEFAULT_GROUP_COLORS = ["#7c8aff", "#4ade80", "#f97316", "#a855f7", "#ec4899", "#3b82f6", "#fbbf24", "#14b8a6"]


def _load() -> dict:
    """Load metadata from disk."""
    os.makedirs(KEYS_DIR, exist_ok=True)
    if os.path.exists(META_FILE):
        with open(META_FILE, "r") as f:
            return json.load(f)
    return {"groups": [], "tags": {}, "audit": {}}


def _save(data: dict):
    """Save metadata to disk."""
    os.makedirs(KEYS_DIR, exist_ok=True)
    with open(META_FILE, "w") as f:
        json.dump(data, f, indent=2)


# ── Groups ────────────────────────────────────────────────────────────────

def list_groups() -> list[dict]:
    """Return all groups."""
    return _load().get("groups", [])


def create_group(name: str, color: str = None, description: str = "") -> dict:
    """Create a new group."""
    data = _load()
    group = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "color": color or DEFAULT_GROUP_COLORS[len(data.get("groups", [])) % len(DEFAULT_GROUP_COLORS)],
        "description": description,
        "keys": [],
    }
    data.setdefault("groups", []).append(group)
    _save(data)
    return group


def update_group(group_id: str, name: str = None, color: str = None, description: str = None) -> dict:
    """Update a group's properties."""
    data = _load()
    for g in data.get("groups", []):
        if g["id"] == group_id:
            if name is not None:
                g["name"] = name
            if color is not None:
                g["color"] = color
            if description is not None:
                g["description"] = description
            _save(data)
            return g
    raise ValueError(f"Group not found: {group_id}")


def delete_group(group_id: str) -> dict:
    """Delete a group."""
    data = _load()
    groups = data.get("groups", [])
    data["groups"] = [g for g in groups if g["id"] != group_id]
    if len(data["groups"]) == len(groups):
        raise ValueError(f"Group not found: {group_id}")
    _save(data)
    return {"deleted": group_id}


def set_key_group(slug: str, group_id: str | None) -> dict:
    """Set a key's group (one group per key). Removes from all groups first."""
    data = _load()

    # Remove from every group
    for g in data.get("groups", []):
        g["keys"] = [k for k in g.get("keys", []) if k != slug]

    # If group_id given, add to that group
    if group_id is not None:
        for g in data.get("groups", []):
            if g["id"] == group_id:
                g["keys"].append(slug)
                _save(data)
                return {"id": g["id"], "name": g["name"], "color": g["color"]}
        raise ValueError(f"Group not found: {group_id}")

    _save(data)
    return {"id": None, "name": "Ungrouped", "color": None}


def add_key_to_group(group_id: str, slug: str) -> dict:
    """Add a key to a group (enforces one-group-per-key)."""
    return set_key_group(slug, group_id)


def remove_key_from_group(group_id: str, slug: str) -> dict:
    """Remove a key from a group."""
    data = _load()
    for g in data.get("groups", []):
        if g["id"] == group_id:
            g["keys"] = [k for k in g["keys"] if k != slug]
            _save(data)
            return g
    raise ValueError(f"Group not found: {group_id}")


def get_key_groups(slug: str) -> list[dict]:
    """Return all groups a key belongs to (will be 0 or 1 with one-group-per-key)."""
    data = _load()
    return [{"id": g["id"], "name": g["name"], "color": g["color"]}
            for g in data.get("groups", []) if slug in g.get("keys", [])]


# ── Tags ──────────────────────────────────────────────────────────────────

def get_tags(slug: str) -> list[str]:
    """Return tags for a key."""
    return _load().get("tags", {}).get(slug, [])


def set_tags(slug: str, tags: list[str]) -> list[str]:
    """Set tags for a key (replaces existing)."""
    data = _load()
    data.setdefault("tags", {})[slug] = tags
    _save(data)
    return tags


def all_tags() -> list[str]:
    """Return all unique tags across all keys."""
    data = _load()
    tags = set()
    for t_list in data.get("tags", {}).values():
        tags.update(t_list)
    return sorted(tags)


# ── Audit Log ─────────────────────────────────────────────────────────────

def log_action(slug: str, action: str, detail: str = ""):
    """Record an action in the audit log for a key."""
    data = _load()
    data.setdefault("audit", {})
    data["audit"].setdefault(slug, [])
    entry = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "action": action,
    }
    if detail:
        entry["detail"] = detail
    data["audit"][slug].append(entry)
    _save(data)


def get_audit_log(slug: str) -> list[dict]:
    """Return audit log entries for a key, newest first."""
    data = _load()
    entries = data.get("audit", {}).get(slug, [])
    return list(reversed(entries))


def cleanup_key_metadata(slug: str):
    """Remove all metadata for a deleted key."""
    data = _load()
    # Remove from groups
    for g in data.get("groups", []):
        g["keys"] = [k for k in g.get("keys", []) if k != slug]
    # Remove tags
    data.get("tags", {}).pop(slug, None)
    # Remove audit log
    data.get("audit", {}).pop(slug, None)
    _save(data)

