from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import uvicorn

from .config import config_path, load_settings, new_token
from .service import create_app


def init_config(path: Path) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    example = Path(__file__).parents[1] / "config.example.toml"
    shutil.copyfile(example, path)
    text = path.read_text(encoding="utf-8").replace("replace-with-a-long-random-token", new_token())
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    print(f"Created {path}. Add the courses and their desired paths before starting the service.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "serve", "install-native-host"), nargs="?", default="serve")
    args = parser.parse_args()
    path = config_path()
    if args.command == "init":
        init_config(path)
        return
    if args.command == "install-native-host":
        manifest_dir = Path.home() / ".mozilla/native-messaging-hosts"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest = {
            "name": "jp.ac.tid.manaba_folder_sync",
            "description": "Reads manaba credentials from Secret Service",
            "path": str(Path(sys.executable).resolve()),
            "type": "stdio",
            "allowed_extensions": ["manaba-folder-sync@local"],
        }
        # Firefox native hosts do not accept command-line arguments. A tiny
        # executable launcher next to the manifest selects the installed module.
        launcher = manifest_dir / "manaba-folder-sync-native-host"
        source_root = Path(__file__).parents[1]
        launcher.write_text(
            f"#!{sys.executable}\nimport sys\nsys.path.insert(0, {str(source_root)!r})\n"
            "from manaba_folder_sync.native_host import main\nmain()\n",
            encoding="utf-8",
        )
        launcher.chmod(0o700)
        manifest["path"] = str(launcher)
        (manifest_dir / "jp.ac.tid.manaba_folder_sync.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print("Installed Firefox native-messaging host. It reads only Secret Service entries for manaba-folder-sync.")
        return
    settings = load_settings(path)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
