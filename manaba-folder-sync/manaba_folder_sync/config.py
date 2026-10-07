from __future__ import annotations

import os
import secrets
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


def config_path() -> Path:
    configured = os.environ.get("MANABA_SYNC_CONFIG")
    if configured:
        return Path(configured).expanduser()
    return Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser() / "manaba-folder-sync/config.toml"


@dataclass(frozen=True)
class Course:
    id: str
    name: str
    path: Path


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    token: str
    base_url: str
    allowed_hosts: frozenset[str]
    storage_root: Path
    collision_policy: str
    courses: dict[str, Course]


def load_settings(path: Path | None = None) -> Settings:
    path = path or config_path()
    if not path.exists():
        raise FileNotFoundError(f"Config not found: {path}. Copy config.example.toml to this path.")
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    server = data["server"]
    manaba = data["manaba"]
    storage = data["storage"]
    root = Path(storage["root"]).expanduser().resolve()
    base_url = str(manaba["base_url"]).rstrip("/")
    base_host = urlparse(base_url).hostname
    if not base_host:
        raise ValueError("manaba.base_url must be an HTTPS URL")
    allowed_hosts = frozenset(str(host).lower() for host in manaba.get("allowed_hosts", [base_host]))
    if urlparse(base_url).scheme != "https":
        raise ValueError("manaba.base_url must use HTTPS")
    policy = storage.get("collision_policy", "rename")
    if policy not in {"rename", "overwrite", "error"}:
        raise ValueError("storage.collision_policy must be rename, overwrite, or error")
    courses: dict[str, Course] = {}
    for course_id, course_data in data.get("courses", {}).items():
        destination = Path(course_data["path"]).expanduser().resolve()
        if not destination.is_relative_to(root):
            raise ValueError(f"Course {course_id} path must be under storage.root: {destination}")
        courses[str(course_id)] = Course(str(course_id), str(course_data.get("name", course_id)), destination)
    return Settings(
        host=str(server.get("host", "127.0.0.1")),
        port=int(server.get("port", 8765)),
        token=str(server["token"]),
        base_url=base_url,
        allowed_hosts=allowed_hosts,
        storage_root=root,
        collision_policy=policy,
        courses=courses,
    )


def new_token() -> str:
    return secrets.token_urlsafe(32)
