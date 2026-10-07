from __future__ import annotations

import re
import unicodedata
from email.message import Message
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from .config import Settings

COURSE_ID_RE = re.compile(r"(?:^|/)course_(\d+)(?:[_/]|$)")
INVALID_FILENAME = re.compile(r"[\\/\x00-\x1f<>:\"|?*]")


class BrowserCookie(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    value: str = Field(max_length=8192)
    domain: str = Field(min_length=1, max_length=255)


class DownloadRequest(BaseModel):
    url: HttpUrl
    course_id: str = Field(pattern=r"^\d+$")
    referer: HttpUrl | None = None
    cookies: list[BrowserCookie] = Field(min_length=1, max_length=100)


class CookieRequest(BaseModel):
    cookies: list[BrowserCookie] = Field(min_length=1, max_length=100)


class CourseResult(BaseModel):
    id: str
    name: str
    configured_path: str | None


class FolderMatch(BaseModel):
    id: str
    name: str
    path: str


class MappingCandidates(BaseModel):
    """Read-only suggestions for entries to add to ``[courses]``."""

    matches: list[FolderMatch]
    unmatched_courses: list[CourseResult]
    registered_courses: list[CourseResult]
    unused_folders: list[str]


def course_id_from_url(url: str) -> str | None:
    return (match.group(1) if (match := COURSE_ID_RE.search(urlparse(url).path)) else None)


def safe_filename(value: str) -> str:
    value = INVALID_FILENAME.sub("_", value).strip(" .")
    return value[:240] or "download"


def content_filename(response: httpx.Response, source_url: str) -> str:
    header = response.headers.get("content-disposition", "")
    message = Message()
    message["content-disposition"] = header
    filename = message.get_param("filename", header="content-disposition")
    if isinstance(filename, tuple):
        filename = filename[2]
    if isinstance(filename, str) and filename:
        return safe_filename(filename)
    return safe_filename(Path(urlparse(source_url).path).name or "download")


def destination_for(directory: Path, filename: str, policy: str) -> Path:
    target = directory / safe_filename(filename)
    if not target.exists() or policy == "overwrite":
        return target
    if policy == "error":
        raise FileExistsError(target)
    stem, suffix = target.stem, target.suffix
    for number in range(1, 10_000):
        candidate = directory / f"{stem} ({number}){suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError("Could not choose a non-conflicting filename")


def host_allowed(url: str, settings: Settings) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname is not None and parsed.hostname.lower() in settings.allowed_hosts


def cookie_header(cookies: list[BrowserCookie], settings: Settings) -> str:
    selected = [cookie for cookie in cookies if cookie.domain.lstrip(".").lower() in settings.allowed_hosts]
    if not selected:
        raise HTTPException(400, "No cookies for an allowed manaba host were supplied")
    return "; ".join(f"{cookie.name}={cookie.value}" for cookie in selected)


def normalized_name(value: str) -> str:
    """Compare names conservatively while allowing common filename spelling variants."""
    return re.sub(r"[\s_-]+", "", unicodedata.normalize("NFKC", value).casefold())


class CourseLinkParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            absolute = urljoin(self.base_url, self._href)
            course_id = course_id_from_url(absolute)
            if course_id:
                self.links.append((course_id, " ".join(self._text).strip()))
        if tag == "a":
            self._href = None


async def fetch_current_courses(request: CookieRequest, settings: Settings) -> list[tuple[str, str]]:
    """Fetch selectable courses using request-scoped browser cookies only."""
    headers = {"Cookie": cookie_header(request.cookies, settings), "User-Agent": "manaba-folder-sync/0.1"}
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        response = await client.get(settings.base_url + "/ct/", headers=headers)
    response_path = urlparse(str(response.url)).path
    if not host_allowed(str(response.url), settings) or (response_path != "/ct" and not response_path.startswith("/ct/")):
        raise HTTPException(401, "manaba session is not authenticated; open manaba and sign in again")
    parser = CourseLinkParser(settings.base_url)
    parser.feed(response.text)
    found: dict[str, str] = {}
    for course_id, name in parser.links:
        found.setdefault(course_id, name or course_id)
    return list(found.items())


def direct_folders(root: Path) -> list[Path]:
    """Return only visible immediate child directories; never recursively inspect Documents."""
    if not root.is_dir():
        return []
    return sorted((entry for entry in root.iterdir() if entry.is_dir() and not entry.name.startswith(".")), key=lambda entry: entry.name.casefold())


def build_mapping_candidates(courses: list[tuple[str, str]], settings: Settings) -> MappingCandidates:
    folders = direct_folders(settings.storage_root)
    by_name: dict[str, list[Path]] = {}
    for folder in folders:
        by_name.setdefault(normalized_name(folder.name), []).append(folder)

    matches: list[FolderMatch] = []
    unmatched_courses: list[CourseResult] = []
    registered_courses: list[CourseResult] = []
    used_folders: set[Path] = set()
    for course_id, name in courses:
        configured = settings.courses.get(course_id)
        if configured is not None:
            registered_courses.append(CourseResult(id=course_id, name=name, configured_path=str(configured.path)))
            continue
        # A folder is suggested at most once.  If duplicate course titles exist,
        # leaving the later one unmatched is safer than silently sharing a path.
        folder = next((item for item in by_name.get(normalized_name(name), []) if item not in used_folders), None)
        if folder is None:
            unmatched_courses.append(CourseResult(id=course_id, name=name, configured_path=None))
            continue
        used_folders.add(folder)
        matches.append(FolderMatch(id=course_id, name=name, path=str(folder)))
    return MappingCandidates(
        matches=matches,
        unmatched_courses=unmatched_courses,
        registered_courses=registered_courses,
        unused_folders=[str(folder) for folder in folders if folder not in used_folders],
    )


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="manaba folder sync", docs_url=None, redoc_url=None)

    def authorize(authorization: str | None) -> None:
        if authorization != f"Bearer {settings.token}":
            raise HTTPException(401, "Invalid local API token")

    @app.get("/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/courses", response_model=list[CourseResult])
    async def courses(authorization: str | None = Header(default=None)) -> list[CourseResult]:
        authorize(authorization)
        return [CourseResult(id=course.id, name=course.name, configured_path=str(course.path)) for course in settings.courses.values()]

    @app.post("/v1/courses/discover", response_model=list[CourseResult])
    async def discover(request: CookieRequest, authorization: str | None = Header(default=None)) -> list[CourseResult]:
        """Fetch the manaba top page with current browser cookies and extract course links."""
        authorize(authorization)
        found = await fetch_current_courses(request, settings)
        return [CourseResult(id=course_id, name=name, configured_path=str(settings.courses[course_id].path) if course_id in settings.courses else None) for course_id, name in found]

    @app.post("/v1/courses/mapping-candidates", response_model=MappingCandidates)
    async def mapping_candidates(request: CookieRequest, authorization: str | None = Header(default=None)) -> MappingCandidates:
        """Suggest config entries from current manaba courses and Documents' direct children."""
        authorize(authorization)
        return build_mapping_candidates(await fetch_current_courses(request, settings), settings)

    @app.post("/v1/downloads")
    async def download(body: DownloadRequest, authorization: str | None = Header(default=None)) -> dict[str, str]:
        authorize(authorization)
        source_url = str(body.url)
        if not host_allowed(source_url, settings):
            raise HTTPException(400, "Download URL host is not allowed")
        course = settings.courses.get(body.course_id)
        if course is None:
            raise HTTPException(409, f"Course {body.course_id} has no configured destination")
        url_course = course_id_from_url(source_url) or (course_id_from_url(str(body.referer)) if body.referer else None)
        if url_course and url_course != body.course_id:
            raise HTTPException(400, "course_id does not match the manaba page URL")
        headers = {"Cookie": cookie_header(body.cookies, settings), "User-Agent": "manaba-folder-sync/0.1"}
        if body.referer and host_allowed(str(body.referer), settings):
            headers["Referer"] = str(body.referer)
        course.path.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
            async with client.stream("GET", source_url, headers=headers) as response:
                response.raise_for_status()
                if not host_allowed(str(response.url), settings):
                    raise HTTPException(400, "Download was redirected outside an allowed host")
                target = destination_for(course.path, content_filename(response, source_url), settings.collision_policy)
                temporary = target.with_name(f".{target.name}.part")
                try:
                    with temporary.open("wb") as file:
                        async for chunk in response.aiter_bytes():
                            file.write(chunk)
                    temporary.replace(target)
                finally:
                    if temporary.exists():
                        temporary.unlink()
        return {"course_id": course.id, "path": str(target), "filename": target.name}

    return app
