from pathlib import Path

from manaba_folder_sync.config import Course, Settings
from manaba_folder_sync.service import build_mapping_candidates, course_id_from_url, destination_for, normalized_name, safe_filename


def test_course_id_is_read_from_course_page_url():
    assert course_id_from_url("https://tid.manaba.jp/ct/course_12345_home") == "12345"
    assert course_id_from_url("https://tid.manaba.jp/ct/home") is None


def test_filename_cannot_escape_destination():
    filename = safe_filename("../../lecture:week1.pdf")
    assert "/" not in filename
    assert "\\" not in filename


def test_destination_renames_existing_file(tmp_path: Path):
    (tmp_path / "notes.pdf").touch()
    assert destination_for(tmp_path, "notes.pdf", "rename").name == "notes (1).pdf"


def settings_for(root: Path, courses: dict[str, Course] | None = None) -> Settings:
    return Settings(
        host="127.0.0.1", port=8765, token="test", base_url="https://tid.manaba.jp",
        allowed_hosts=frozenset({"tid.manaba.jp"}), storage_root=root,
        collision_policy="rename", courses=courses or {},
    )


def test_normalized_name_ignores_case_spaces_underscores_and_hyphens():
    assert normalized_name("Data Base") == normalized_name("data_base") == normalized_name("DATA-base")


def test_mapping_candidates_only_use_current_courses_and_direct_visible_folders(tmp_path: Path):
    (tmp_path / "Data Base").mkdir()
    (tmp_path / "Old Course").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "Data Base" / "nested").mkdir()
    result = build_mapping_candidates([("10", "data_base"), ("20", "Current course")], settings_for(tmp_path))
    assert [(item.id, item.path) for item in result.matches] == [("10", str(tmp_path / "Data Base"))]
    assert [item.id for item in result.unmatched_courses] == ["20"]
    assert result.unused_folders == [str(tmp_path / "Old Course")]


def test_mapping_candidates_separate_registered_courses(tmp_path: Path):
    (tmp_path / "database").mkdir()
    configured = Course("10", "database", tmp_path / "database")
    result = build_mapping_candidates([("10", "Database"), ("20", "database")], settings_for(tmp_path, {"10": configured}))
    assert [item.id for item in result.registered_courses] == ["10"]
    assert [item.id for item in result.matches] == ["20"]
